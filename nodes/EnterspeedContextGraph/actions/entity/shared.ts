import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';

/**
 * ingest/ADR-020: a request over the environment's concurrency cap is refused
 * with 429 and a Retry-After, with nothing written, and "any workflow-tool
 * integration retry with the given delay". The refused request is resent
 * after that delay, at most this many times, before the run fails.
 */
export const MAX_THROTTLE_RETRIES = 3;

/** Used when a 429 carries no readable Retry-After. */
const DEFAULT_RETRY_AFTER_MS = 1000;

/** A Retry-After longer than this fails the run rather than holding it open. */
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Ingest caps a request body at 32 MiB (provisional, ingest/ADR-020 D5).
 * A request is closed before it would pass this, with headroom. It is the
 * only reason Push Many splits a list into several requests: neither
 * operation is the bulk path (that is an artifact upload, cross/ADR-022).
 */
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

/** The five $ fields of one record, as resolved for sending. */
export interface RecordFields {
	id: unknown;
	type: unknown;
	source: unknown;
	action: unknown;
	modifiedAt: unknown;
}

export interface Line {
	/** The input item the record came from, which its result is paired to. */
	itemIndex: number;
	id: unknown;
	type: unknown;
	source?: string;
	action: 'upsert' | 'delete';
	/** The record as one NDJSON line, without its trailing newline. */
	ndjson: string;
	bytes: number;
}

export type Rejected = Pick<Line, 'itemIndex' | 'id' | 'type' | 'source' | 'action'> & {
	error: string;
	/** The failed request's detail, carried on the result with Continue On Fail. */
	description?: string | null;
};

interface ItemResult {
	id: string;
	accepted: boolean;
	error?: string;
	statusCode?: number;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Why an `$id` or `$type` value can't be sent, or undefined if it can. The
 * contract makes a missing, non-string or whitespace-only value a parse
 * error; the value is never converted or trimmed, since `$id` is kept as sent.
 */
function invalid(name: string, value: unknown): string | undefined {
	if (isEmpty(value) || (typeof value === 'string' && !value.trim())) return `is missing ${name}`;
	if (typeof value !== 'string') return `has ${name} that is not text`;
	return undefined;
}

/**
 * Builds one record's NDJSON line: the record's fields as they are, with
 * `$id`, `$type`, `$source`, `$action` and `$modifiedAt` set from `fields`.
 * A delete carries no other fields. `where` names the record in errors
 * (e.g. "Item 2" or "Item 0, record 3").
 */
export function buildLine(where: string, itemIndex: number, fields: RecordFields, json: IDataObject): Line | Rejected {
	const { id, type, modifiedAt } = fields;
	const action =
		typeof fields.action === 'string' && fields.action.toLowerCase() === 'delete' ? 'delete' : 'upsert';
	const source = isEmpty(fields.source) ? undefined : String(fields.source);
	const result = { itemIndex, id, type, source, action } as const;

	const problems = [invalid('Entity ID', id), invalid('Entity Type', type)].filter(Boolean);
	// The type checks repeat what `invalid` found, so TypeScript knows both are text.
	if (problems.length || typeof id !== 'string' || typeof type !== 'string') {
		return { ...result, error: `${where} ${problems.join(' and ')}.` };
	}

	let record: IDataObject;
	if (action === 'delete') {
		record = { $id: id, $type: type };
		if (source !== undefined) record.$source = source;
		record.$action = 'delete';
	} else {
		// Assigning keeps each $ field where the record already had it.
		record = { ...json, $id: id, $type: type };
		if (source !== undefined) record.$source = source;
		else delete record.$source;
		delete record.$action;
	}
	if (isEmpty(modifiedAt)) delete record.$modifiedAt;
	else record.$modifiedAt = modifiedAt as IDataObject[string];

	const ndjson = JSON.stringify(record);
	// +1 for the newline that ends the line in the request body.
	const bytes = new TextEncoder().encode(ndjson).length + 1;
	if (bytes > MAX_REQUEST_BYTES) {
		return { ...result, error: `${where} is larger than the Ingest URL accepts in one request.` };
	}
	return { ...result, ndjson, bytes };
}

/** Groups lines into requests that stay under MAX_REQUEST_BYTES. */
export function toRequests(lines: Line[]): Line[][] {
	const requests: Line[][] = [];
	let current: Line[] = [];
	let bytes = 0;
	for (const l of lines) {
		if (current.length && bytes + l.bytes > MAX_REQUEST_BYTES) {
			requests.push(current);
			current = [];
			bytes = 0;
		}
		current.push(l);
		bytes += l.bytes;
	}
	if (current.length) requests.push(current);
	return requests;
}

/** A 429's Retry-After (delay in seconds, or an HTTP date) in milliseconds. */
function retryAfterMs(error: unknown): number {
	const value = httpFailure(error).headers?.['retry-after'];
	const raw = Array.isArray(value) ? value[0] : value;
	if (typeof raw === 'number') return Math.max(0, raw * 1000);
	if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_RETRY_AFTER_MS;
	const seconds = Number(raw);
	if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(raw);
	return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - Date.now());
}

/**
 * Turns a failed request into a message that says what went wrong without
 * repeating the request (it carries record content) or the key.
 */
function requestError(this: IExecuteFunctions, error: unknown, ingestUrl: string): NodeApiError | NodeOperationError {
	const { status } = httpFailure(error);
	// No status means no answer at all. NodeApiError swaps its own wording in
	// for connection codes (ECONNREFUSED etc.), which would drop the URL.
	if (status === undefined) {
		return new NodeOperationError(this.getNode(), `Couldn't reach the Ingest URL (${ingestUrl}).`, {
			description: (error as Error).message,
		});
	}
	let message: string;
	if (status === 401) message = 'The API key was rejected by the Ingest URL.';
	// A whole-request 403 is a key without Write scope (ingest ADR 011).
	else if (status === 403) message = "The API key isn't allowed to write to this Context Graph.";
	else if (status === 413) message = 'The Ingest URL refused the request as too large.';
	else if (status === 429) message = 'The Ingest URL is still throttling requests after retrying. Try again later.';
	else message = `The Ingest URL answered with status ${status}.`;
	const httpCode = String(status);
	// A plain object, not the request's own error: NodeApiError hands back an
	// existing NodeApiError unchanged, which would drop this message.
	return new NodeApiError(this.getNode(), { httpCode }, { message, httpCode });
}

/**
 * Sends one request, resending it after Retry-After while the service
 * answers 429 (ingest/ADR-020). Any other failure, or a 429 past the retry
 * limit, throws the node error `requestError` builds.
 */
async function send(this: IExecuteFunctions, ingestUrl: string, body: string): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await contextGraphApiRequest.call(this, {
				method: 'POST',
				url: `${ingestUrl}/entities`,
				headers: { 'Content-Type': 'application/x-ndjson' },
				body,
				json: false,
			});
		} catch (error) {
			const delay = httpFailure(error).status === 429 ? retryAfterMs(error) : undefined;
			if (delay === undefined || attempt >= MAX_THROTTLE_RETRIES || delay > MAX_RETRY_AFTER_MS) {
				throw requestError.call(this, error, ingestUrl);
			}
			await sleep(delay);
		}
	}
}

function parseResults(response: unknown): unknown {
	if (typeof response !== 'string') return response;
	try {
		return JSON.parse(response);
	} catch {
		return undefined;
	}
}

/** One record's result, paired to the item it came from. */
function resultItem(
	l: Pick<Line, 'itemIndex' | 'id' | 'type' | 'source' | 'action'>,
	outcome: IDataObject,
): INodeExecutionData {
	return {
		json: {
			id: l.id as IDataObject[string],
			type: l.type as IDataObject[string],
			...(l.source !== undefined && { source: l.source }),
			action: l.action,
			...outcome,
		},
		pairedItem: { item: l.itemIndex },
	};
}

export const failedResult = (l: Rejected) =>
	resultItem(l, { accepted: false, error: l.error, ...(l.description && { description: l.description }) });

/**
 * Sends each request in turn and returns one result per line. The service
 * answers a per-line `{ id, accepted, error?, statusCode }` array in line
 * order (Ingest bulk-result envelope), which is zipped back onto the lines.
 * A failed request stops the run, or with Continue On Fail fails its lines.
 */
export async function sendRequests(
	this: IExecuteFunctions,
	ingestUrl: string,
	requests: Line[][],
): Promise<Map<Line, INodeExecutionData>> {
	const results = new Map<Line, INodeExecutionData>();

	for (const request of requests) {
		let parsed: unknown;
		try {
			const response = await send.call(this, ingestUrl, request.map((l) => l.ndjson).join('\n') + '\n');
			parsed = parseResults(response);
		} catch (error) {
			const nodeError = error as NodeApiError | NodeOperationError;
			if (!this.continueOnFail()) throw nodeError;
			request.forEach((l) =>
				results.set(l, failedResult({ ...l, error: nodeError.message, description: nodeError.description })),
			);
			continue;
		}

		if (!Array.isArray(parsed) || parsed.length !== request.length) {
			const message = `Expected ${request.length} results from the Ingest URL but got ${Array.isArray(parsed) ? parsed.length : 'none'}`;
			if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), message);
			request.forEach((l) => results.set(l, failedResult({ ...l, error: message })));
			continue;
		}

		request.forEach((l, i) => {
			const r = parsed[i] as ItemResult;
			results.set(
				l,
				resultItem(l, {
					accepted: r.accepted === true,
					...(r.statusCode !== undefined && { statusCode: r.statusCode }),
					...(r.error && { error: r.error }),
				}),
			);
		});
	}

	return results;
}
