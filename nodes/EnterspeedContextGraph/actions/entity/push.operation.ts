import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';

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
 * only reason a run is split into several requests: Push is not the bulk
 * path (that is an artifact upload, cross/ADR-022).
 */
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

const show = { resource: ['entity'], operation: ['push'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Entity ID',
		name: 'entityId',
		type: 'string',
		default: '={{ $json.$id }}',
		required: true,
		displayOptions: { show },
		description:
			"The source system's own record key, sent as the record's $-prefixed ID field. Unique within the source and the same every time the record is sent, so sending it again updates the entity and a delete finds it. Must be text. Defaults to the record's own key.",
	},
	{
		displayName: 'Entity Type',
		name: 'entityType',
		type: 'string',
		default: '={{ $json.$type }}',
		required: true,
		displayOptions: { show },
		description: "The entity type, sent as $type. Must be text. Defaults to the record's own $type.",
	},
	{
		displayName: 'Source',
		name: 'source',
		type: 'string',
		default: '={{ $json.$source }}',
		displayOptions: { show },
		description:
			"The source the record belongs to, sent as $source. When empty, the Context Graph takes the source from the API key (the local dev-server can't, and rejects the record). Defaults to the record's own $source.",
	},
	{
		displayName: 'Action',
		name: 'action',
		type: 'string',
		default: '={{ $json.$action }}',
		displayOptions: { show },
		description:
			"'delete' removes the entity; anything else, or empty, saves the record. A delete sends only the entity's ID, type, source and modified time. Defaults to the record's own $action.",
	},
	{
		displayName: 'Modified At',
		name: 'modifiedAt',
		type: 'string',
		default: '={{ $json.$modifiedAt }}',
		displayOptions: { show },
		description:
			"When the record last changed in the source, as an ISO 8601 time with an offset, sent as $modifiedAt. Writes to an entity are applied in this order, so an older write that arrives late doesn't overwrite a newer one. A record sent without one is applied, but a later upload of the source's export can overwrite it. Defaults to the record's own $modifiedAt.",
	},
];

interface Line {
	itemIndex: number;
	id: unknown;
	type: unknown;
	source?: string;
	action: 'upsert' | 'delete';
	/** The record as one NDJSON line, without its trailing newline. */
	ndjson: string;
	bytes: number;
}

interface ItemResult {
	id: string;
	accepted: boolean;
	error?: string;
	statusCode?: number;
}

type Rejected = Pick<Line, 'itemIndex' | 'id' | 'type' | 'source' | 'action'> & {
	error: string;
	/** The failed request's detail, carried on the item with Continue On Fail. */
	description?: string | null;
};

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
 * Builds one item's record: the item's fields as they are, with `$id`,
 * `$type`, `$source`, `$action` and `$modifiedAt` set from the node fields
 * (which default to the record's own). A delete carries no other fields.
 */
function buildLine(this: IExecuteFunctions, itemIndex: number, json: IDataObject): Line | Rejected {
	const id = this.getNodeParameter('entityId', itemIndex, undefined);
	const type = this.getNodeParameter('entityType', itemIndex, undefined);
	const rawSource = this.getNodeParameter('source', itemIndex, undefined);
	const actionValue = this.getNodeParameter('action', itemIndex, undefined);
	const modifiedAt = this.getNodeParameter('modifiedAt', itemIndex, undefined);

	const action = typeof actionValue === 'string' && actionValue.toLowerCase() === 'delete' ? 'delete' : 'upsert';
	const source = isEmpty(rawSource) ? undefined : String(rawSource);
	const fields = { itemIndex, id, type, source, action } as const;

	const problems = [invalid('Entity ID', id), invalid('Entity Type', type)].filter(Boolean);
	if (problems.length) return { ...fields, error: `Item ${itemIndex} ${problems.join(' and ')}.` };

	let record: IDataObject;
	if (action === 'delete') {
		record = { $id: id, $type: type };
		if (source !== undefined) record.$source = source;
		record.$action = 'delete';
	} else {
		// Assigning keeps each $ field where the item already had it.
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
		return { ...fields, error: `Item ${itemIndex} is larger than the Ingest URL accepts in one request.` };
	}
	return { ...fields, ndjson, bytes };
}

/** Groups lines into requests that stay under MAX_REQUEST_BYTES. */
function toRequests(lines: Line[]): Line[][] {
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

interface HttpError {
	httpCode?: string;
	statusCode?: number;
	response?: { status?: number; headers?: Record<string, unknown> };
}

function statusOf(error: unknown): number | undefined {
	const e = error as HttpError;
	return e.response?.status ?? e.statusCode ?? (e.httpCode ? Number(e.httpCode) : undefined);
}

/** A 429's Retry-After (delay in seconds, or an HTTP date) in milliseconds. */
function retryAfterMs(error: unknown): number {
	const value = (error as HttpError).response?.headers?.['retry-after'];
	const raw = Array.isArray(value) ? value[0] : value;
	if (typeof raw === 'number') return Math.max(0, raw * 1000);
	if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_RETRY_AFTER_MS;
	const seconds = Number(raw);
	if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(raw);
	return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - Date.now());
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
			const delay = statusOf(error) === 429 ? retryAfterMs(error) : undefined;
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

/**
 * Turns a failed request into a message that says what went wrong without
 * repeating the request (it carries record content) or the key.
 */
function requestError(this: IExecuteFunctions, error: unknown, ingestUrl: string): NodeApiError | NodeOperationError {
	const status = statusOf(error);
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
	return new NodeApiError(this.getNode(), error as JsonObject, { message, httpCode: String(status) });
}

/**
 * Pushes every input item, as the record it is, to `POST {ingestUrl}/entities`.
 * Outputs one result per item, in input order: items the service rejected,
 * and items without a valid ID or type, come out with `accepted: false` and
 * the reason instead of stopping the run.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: Array<INodeExecutionData | undefined> = new Array(items.length);
	const lines: Line[] = [];

	const result = (l: Pick<Line, 'itemIndex' | 'id' | 'type' | 'source' | 'action'>, outcome: IDataObject) => {
		results[l.itemIndex] = {
			json: {
				id: l.id as IDataObject[string],
				type: l.type as IDataObject[string],
				...(l.source !== undefined && { source: l.source }),
				action: l.action,
				...outcome,
			},
			pairedItem: { item: l.itemIndex },
		};
	};
	const fail = (l: Rejected) =>
		result(l, { accepted: false, error: l.error, ...(l.description && { description: l.description }) });

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const built = buildLine.call(this, itemIndex, items[itemIndex].json);
		if ('error' in built) fail(built);
		else lines.push(built);
	}

	for (const request of toRequests(lines)) {
		let parsed: unknown;
		try {
			const response = await send.call(this, creds.ingestUrl, request.map((l) => l.ndjson).join('\n') + '\n');
			parsed = parseResults(response);
		} catch (error) {
			const nodeError = error as NodeApiError | NodeOperationError;
			if (!this.continueOnFail()) throw nodeError;
			request.forEach((l) => fail({ ...l, error: nodeError.message, description: nodeError.description }));
			continue;
		}

		if (!Array.isArray(parsed) || parsed.length !== request.length) {
			const message = `Expected ${request.length} results from the Ingest URL but got ${Array.isArray(parsed) ? parsed.length : 'none'}`;
			if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), message);
			request.forEach((l) => fail({ ...l, error: message }));
			continue;
		}

		// The service answers one result per line, in line order.
		request.forEach((l, i) => {
			const r = parsed[i] as ItemResult;
			result(l, {
				accepted: r.accepted === true,
				...(r.statusCode !== undefined && { statusCode: r.statusCode }),
				...(r.error && { error: r.error }),
			});
		});
	}

	return results.filter((r): r is INodeExecutionData => r !== undefined);
}
