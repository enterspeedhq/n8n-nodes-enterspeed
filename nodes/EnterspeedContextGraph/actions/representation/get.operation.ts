import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';
import { deliveryReadRequest, header, httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { API_VERSION, deliveryError } from '../shape/shared';
import { deliveryHeader, parseContextFieldId, routeSegments } from '../schema/msd';

const show = { resource: ['representation'], operation: ['get'] };
const fromSchema = { ...show, routeFrom: ['schema'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Route From',
		name: 'routeFrom',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Schema',
				value: 'schema',
				description: "Choose a representation and route from the manifest's schema, and give its values",
			},
			{ name: 'Route', value: 'route', description: 'Give the whole route path as text' },
		],
		default: 'route',
		description: 'How the route is given',
		displayOptions: { show },
	},
	{
		displayName: 'Representation Name or ID',
		name: 'representation',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getRepresentations' },
		default: '',
		required: true,
		description:
			'The representation to read, from the schema of the manifest. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: fromSchema },
	},
	{
		displayName: 'Route Name or ID',
		name: 'representationRoute',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getRepresentationRoutes', loadOptionsDependsOn: ['representation'] },
		default: '',
		required: true,
		description:
			'Which of the routes of the representation to read. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: fromSchema },
	},
	{
		displayName: 'Context',
		name: 'context',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		typeOptions: {
			loadOptionsDependsOn: ['representation', 'representationRoute'],
			resourceMapper: {
				resourceMapperMethod: 'getRouteValues',
				mode: 'add',
				fieldWords: { singular: 'value', plural: 'values' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
			},
		},
		description:
			"The values the representation's slots read: each route placeholder, then each value a query or header binder declares. Path values fill the route; the rest go in the query string or a header, as the binder says. A value no binder declares isn't listed: the Context Graph would ignore it.",
		displayOptions: { show: fromSchema },
	},
	{
		displayName: 'Route',
		name: 'route',
		type: 'string',
		default: '={{ $json.route }}',
		required: true,
		placeholder: 'e.g. /products/42',
		displayOptions: { show: { ...show, routeFrom: ['route'] } },
		description: "The representation's route path, starting with a slash, as the schema declares it",
	},
	{
		displayName: 'If-None-Match',
		name: 'ifNoneMatch',
		type: 'string',
		default: '',
		placeholder: 'e.g. {{ $json.etag }}',
		displayOptions: { show },
		description:
			"The ETag kept from an earlier read of this route, sent as the If-None-Match header. If the representation hasn't changed, the Context Graph answers 304 Not Modified and the item says so instead of carrying the representation. Empty sends no header.",
	},
	{
		displayName: 'Include Response Headers',
		name: 'includeResponseHeaders',
		type: 'boolean',
		default: false,
		displayOptions: { show },
		description:
			'Whether to output each item as { status, headers, body }, with whichever of the ETag, Cache-Control, Cache-Tag and Vary headers the Context Graph sent. Keep the ETag to send it back in If-None-Match on the next run.',
	},
	{
		displayName: 'Resume Partial Answers',
		name: 'resumePartial',
		type: 'boolean',
		default: false,
		displayOptions: { show },
		description:
			"Whether to complete a partial answer in the same run: when it carries $metadata.$resume, read the route again with that checkpoint until the open slots resolve or Max Rounds is reached. Off, the partial answer is output as it is.",
	},
	{
		displayName: 'Max Rounds',
		name: 'maxResumeRounds',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 3,
		displayOptions: { show: { ...show, resumePartial: [true] } },
		description:
			"How many resume requests to send at most per item. At the limit the item is output as it is, and each open slot's $state shows it is still open.",
	},
	{
		displayName: 'Max Wait Between Rounds (Ms)',
		name: 'maxResumeWaitMs',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 5000,
		displayOptions: { show: { ...show, resumePartial: [true] } },
		description:
			'The longest wait before a resume request. The node waits for the largest $timeoutMs among the open slots, up to this. A deferred slot carries no $timeoutMs and is resumed at once.',
	},
];

/** A request built from the schema: the route's segments, unencoded, plus query string and headers. */
export interface SchemaRequest {
	segments: string[];
	qs: IDataObject;
	headers: IDataObject;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Fills a route template from the context values (field id `path:`, `query:`
 * or `header:` plus the name). Returns why it can't when a path value or a
 * required value is missing. Empty optional values are left out.
 */
export function buildSchemaRequest(
	template: string,
	values: IDataObject,
	fields: Array<{ id: string; required?: boolean }>,
): SchemaRequest | string {
	const request: SchemaRequest = { segments: [], qs: {}, headers: {} };
	for (const segment of routeSegments(template)) {
		if ('literal' in segment) {
			request.segments.push(segment.literal);
			continue;
		}
		const value = values[`path:${segment.placeholder}`];
		if (isEmpty(value)) return `has no value for "${segment.placeholder}"`;
		request.segments.push(String(value));
	}
	for (const field of fields) {
		const target = parseContextFieldId(field.id);
		if (!target || target.target === 'path') continue;
		const value = values[field.id];
		if (isEmpty(value)) {
			if (field.required) return `has no value for "${target.name}"`;
			continue;
		}
		// A header binder reads X-Delivery-<key or context key> (binder-constraint).
		if (target.target === 'header') request.headers[deliveryHeader(target.name)] = value as IDataObject[string];
		else request.qs[target.name] = value as IDataObject[string];
	}
	return request;
}

/** The item's route, as given, or the request filled from the schema's route template. */
function itemRequest(this: IExecuteFunctions, itemIndex: number): { route: unknown; request?: SchemaRequest | string } {
	if (this.getNodeParameter('routeFrom', itemIndex, 'route') !== 'schema') {
		return { route: this.getNodeParameter('route', itemIndex, undefined) };
	}
	const template = this.getNodeParameter('representationRoute', itemIndex, '') as string;
	if (!template) return { route: template, request: 'has no Route' };
	const values = (this.getNodeParameter('context.value', itemIndex, {}) ?? {}) as IDataObject;
	const fields = (this.getNodeParameter('context.schema', itemIndex, []) ?? []) as Array<{ id: string; required?: boolean }>;
	return { route: template, request: buildSchemaRequest(template, values, fields) };
}

/**
 * Why a route can't be sent, or undefined if it can. Only a missing, blank,
 * non-text or relative route is caught here; whether it matches a
 * representation is the service's to judge. The route is never trimmed.
 */
export function invalidRoute(route: unknown): string | undefined {
	if (route === undefined || route === null || (typeof route === 'string' && !route.trim())) return 'has no Route';
	if (typeof route !== 'string') return 'has a Route that is not text';
	if (!route.startsWith('/')) return `has a Route that doesn't start with "/" ("${route}")`;
	// A query string would be encoded into the path and match no route. Query
	// and header values are the schema's binders, sent by Route From › Schema.
	if (/[?#]/.test(route))
		return `has a Route with "?" or "#" ("${route}"). Give only the path; to send query or header values, set Route From to Schema`;
	return undefined;
}

/**
 * `{deliveryUrl}/v1/{manifest}{route}`, the data plane (delivery/ADR-030 §3).
 * Each segment is percent-encoded and the slashes kept, so a value with URL
 * characters reaches the service as written.
 */
export const representationUrl = (creds: ContextGraphCredentials, route: string) =>
	`${creds.deliveryUrl}/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}${route
		.split('/')
		.map(encodeURIComponent)
		.join('/')}`;

function asObject(response: unknown): IDataObject | undefined {
	let value = response;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : undefined;
}

/** How a run resumes a partial answer (delivery/ADR-033), or undefined when it doesn't. */
export interface ResumeSettings {
	maxRounds: number;
	maxWaitMs: number;
}

/** The states in the pending status class: still open, and resumable (Representation envelope). */
const OPEN_STATES = new Set(['pending', 'deferred']);

const slotEntries = (metadata: IDataObject) =>
	Object.entries(metadata).filter(
		(entry): entry is [string, IDataObject] =>
			!entry[0].startsWith('$') && entry[1] !== null && typeof entry[1] === 'object',
	);

/** The checkpoint a partial answer carries in `$metadata.$resume`, if any. Never parsed. */
export function resumeToken(representation: IDataObject): string | undefined {
	const token = (representation.$metadata as IDataObject | undefined)?.$resume;
	return typeof token === 'string' && token !== '' ? token : undefined;
}

/**
 * The open slots a resume round may complete. The node sends no context
 * token, so a slot whose `$requires` names a claim is skipped (the client
 * resume guard, Representation slot spec, rule 1); an absent or empty
 * `$requires` resumes (rule 4).
 */
export function resumableSlots(representation: IDataObject): Array<[string, IDataObject]> {
	const metadata = (representation.$metadata ?? {}) as IDataObject;
	return slotEntries(metadata).filter(([, entry]) => {
		if (!OPEN_STATES.has(entry.$state as string)) return false;
		const requires = entry.$requires;
		return !Array.isArray(requires) || requires.length === 0;
	});
}

/**
 * How long to wait before the next round: the largest `$timeoutMs` among the
 * slots to resume, capped. A `deferred` slot carries none (Representation
 * slot spec), so a round of only deferred slots goes at once.
 */
export function resumeWaitMs(slots: Array<[string, IDataObject]>, maxWaitMs: number): number {
	const hints = slots.map(([, entry]) => entry.$timeoutMs).filter((ms): ms is number => typeof ms === 'number' && ms > 0);
	return hints.length ? Math.min(Math.max(...hints), Math.max(0, maxWaitMs)) : 0;
}

const newer = (a: unknown, b: unknown) => {
	if (typeof a !== 'string') return b;
	if (typeof b !== 'string') return a;
	return Date.parse(b) > Date.parse(a) ? b : a;
};

/**
 * Merges a resume round into the answer so far. A round answers only the
 * slots that were open, so each slot and its `$metadata` entry are replaced
 * by name, and nothing else changes (Representation envelope; delivery/ADR-033
 * §2b). `$metadata.$changedAt` is the newest across rounds, and `$resume` is
 * the round's own: absent once nothing is open.
 */
export function mergeResumeRound(answer: IDataObject, round: IDataObject): IDataObject {
	const merged: IDataObject = { ...answer };
	const metadata: IDataObject = { ...((answer.$metadata ?? {}) as IDataObject) };
	const roundMetadata = (round.$metadata ?? {}) as IDataObject;
	for (const [key, value] of Object.entries(round)) {
		if (key !== '$metadata') merged[key] = value;
	}
	for (const [key, value] of Object.entries(roundMetadata)) {
		if (!key.startsWith('$')) metadata[key] = value;
	}
	const changedAt = newer(metadata.$changedAt, roundMetadata.$changedAt);
	if (changedAt !== undefined) metadata.$changedAt = changedAt as IDataObject[string];
	delete metadata.$resume;
	if (roundMetadata.$resume !== undefined) metadata.$resume = roundMetadata.$resume;
	merged.$metadata = metadata;
	return merged;
}

/** The `WWW-Authenticate` hint delivery adds to a refused checkpoint, e.g. `X-Resume error="invalid_checkpoint"`. */
function checkpointHint(headers: Record<string, unknown> | undefined): string {
	const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'www-authenticate');
	return entry ? String(entry[1]) : '';
}

/**
 * Whether a refused resume round is answered by reading the route again
 * without the checkpoint (delivery/ADR-033 §3): an expired checkpoint (`410`,
 * "the client re-GETs"), a manifest or resource mismatch (`409`, "the client
 * re-GETs"), or a checkpoint the service doesn't accept (`401`
 * `invalid_checkpoint`, as delivery and the dev-server word it). A `401` or
 * `410` without that hint is the key or the API version, as on any read.
 */
export function refusedCheckpoint(error: unknown): boolean {
	const { status, headers } = httpFailure(error);
	const hint = checkpointHint(headers);
	if (status === 409) return true;
	if (status === 401) return hint.includes('invalid_checkpoint');
	if (status === 410) return hint.includes('checkpoint_expired');
	return false;
}

/** The error a refused checkpoint gets when there's no fallback left. */
function checkpointError(this: IExecuteFunctions, error: unknown, route: unknown, itemIndex: number): NodeApiError {
	const { status, data } = httpFailure(error);
	const httpCode = String(status);
	const fromService =
		typeof data === 'string' && data ? data : (data as IDataObject | undefined)?.message;
	return new NodeApiError(
		this.getNode(),
		{ httpCode },
		{
			message:
				typeof fromService === 'string' && fromService
					? fromService
					: `The Delivery URL refused the resume checkpoint for route "${route}" (status ${httpCode}).`,
			httpCode,
			itemIndex,
		},
	);
}

/**
 * The response headers Include Response Headers outputs, under these names:
 * the ones the Context Graph MCP server's `includeHeaders` returns.
 */
export const OUTPUT_HEADERS = ['Cache-Tag', 'ETag', 'Cache-Control', 'Vary'];

/** Whichever of OUTPUT_HEADERS the response carries. */
export function outputHeaders(headers: Record<string, unknown> | undefined): IDataObject {
	const selected: IDataObject = {};
	for (const name of OUTPUT_HEADERS) {
		const value = header(headers, name.toLowerCase());
		if (value !== undefined) selected[name] = value;
	}
	return selected;
}

/** How a read is sent and output beyond the plain representation; both off by default. */
export interface RevalidateSettings {
	/** Sent as `If-None-Match` on the first read of the route, when not blank. */
	ifNoneMatch?: string;
	includeHeaders: boolean;
}

/**
 * One item's answer: the representation, or `notModified` when the Context
 * Graph answered `304` to If-None-Match. `status` and `headers` are those of
 * the last response read, when they were asked for.
 */
export interface RepresentationAnswer {
	body?: IDataObject;
	notModified?: boolean;
	status?: number;
	headers?: Record<string, unknown>;
}

/** An answer as the item outputs it. */
export function answerJson(answer: RepresentationAnswer, includeHeaders: boolean): IDataObject {
	if (!includeHeaders) return answer.notModified ? { notModified: true } : (answer.body as IDataObject);
	return {
		status: answer.status as number,
		headers: outputHeaders(answer.headers),
		body: answer.notModified ? null : (answer.body as IDataObject),
	};
}

/** One item's answer, or the error that stops it. */
async function readRepresentation(
	this: IExecuteFunctions,
	route: unknown,
	itemIndex: number,
	creds: ContextGraphCredentials,
	request?: SchemaRequest | string,
	resume?: ResumeSettings,
	revalidate: RevalidateSettings = { includeHeaders: false },
): Promise<RepresentationAnswer | NodeApiError | NodeOperationError> {
	const problem = typeof request === 'string' ? request : request ? undefined : invalidRoute(route);
	if (problem) return new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });
	const fromSchema = typeof request === 'object' ? request : undefined;
	const notAnObject = () =>
		new NodeOperationError(this.getNode(), `The Delivery URL didn't answer with a representation for route "${route}".`, {
			itemIndex,
		});
	// A 404 is an unknown route, an unresolved required slot, or no slot
	// resolved at all.
	const failed = (error: unknown) =>
		deliveryError.call(this, error, creds, { itemIndex, notFound: `No representation for route "${route}".` });

	// The status and headers are read only when asked for, so a plain read
	// is sent as it always was.
	const fullResponse = revalidate.includeHeaders || revalidate.ifNoneMatch !== undefined;
	let status: number | undefined;
	let responseHeaders: Record<string, unknown> | undefined;

	// A resume round repeats the request exactly, query string and headers
	// included, since delivery reads them again on every round; only
	// X-Resume is added, holding the checkpoint as it came (delivery/ADR-033 §2).
	// If-None-Match goes only on the first read: delivery tags only a complete
	// 200 to a fresh GET, never a resume round (RepresentationEndpoints).
	const send = async (checkpoint?: string, ifNoneMatch?: string) => {
		const headers: IDataObject = {
			...(fromSchema?.headers ?? {}),
			...(checkpoint && { 'X-Resume': checkpoint }),
			...(ifNoneMatch !== undefined && { 'If-None-Match': ifNoneMatch }),
		};
		const response = await deliveryReadRequest.call(this, {
			method: 'GET',
			url: fromSchema
				? `${creds.deliveryUrl}/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}/${fromSchema.segments.map(encodeURIComponent).join('/')}`
				: representationUrl(creds, route as string),
			...(fromSchema && Object.keys(fromSchema.qs).length && { qs: fromSchema.qs }),
			...(Object.keys(headers).length && { headers }),
			json: true,
			...(fullResponse && { returnFullResponse: true }),
		});
		if (!fullResponse) return asObject(response);
		const full = (response ?? {}) as { body?: unknown; headers?: Record<string, unknown>; statusCode?: number };
		status = full.statusCode;
		responseHeaders = full.headers;
		// 200, 202 and 207 all carry the body; which slots resolved is in
		// $metadata.<slot>.$state, not the status (Representation envelope).
		return asObject(full.body);
	};
	const done = (body: IDataObject): RepresentationAnswer => ({ body, status, headers: responseHeaders });

	let answer: IDataObject | undefined;
	try {
		answer = await send(undefined, revalidate.ifNoneMatch);
	} catch (error) {
		// n8n's request helper fails a 304 like any status outside 2xx; it is
		// read from the failure, so every other status keeps its wording and a
		// 503 its retry. It counts only when If-None-Match was sent.
		const failure = httpFailure(error);
		if (failure.status === 304 && revalidate.ifNoneMatch !== undefined) {
			return { notModified: true, status: 304, headers: failure.headers };
		}
		return failed(error);
	}
	if (!answer) return notAnObject();
	if (!resume) return done(answer);

	// Rounds go on while the answer carries a checkpoint and a slot it may
	// complete, up to Max Rounds; each answer carries a fresh checkpoint while
	// a slot is still open (Representation envelope, `follows` vectors).
	let fellBack = false;
	for (let round = 0; round < resume.maxRounds; round++) {
		const checkpoint = resumeToken(answer);
		const slots = resumableSlots(answer);
		if (!checkpoint || !slots.length) break;
		const waitMs = resumeWaitMs(slots, resume.maxWaitMs);
		if (waitMs > 0) await sleep(waitMs);

		let next: IDataObject | undefined;
		try {
			next = await send(checkpoint);
		} catch (error) {
			if (!refusedCheckpoint(error)) return failed(error);
			if (fellBack) return checkpointError.call(this, error, route, itemIndex);
			// Read the route again without the checkpoint, once; the fresh
			// answer replaces what the rounds had built.
			fellBack = true;
			try {
				next = await send();
			} catch (retryError) {
				return failed(retryError);
			}
			if (!next) return notAnObject();
			answer = next;
			continue;
		}
		if (!next) return notAnObject();
		answer = mergeResumeRound(answer, next);
	}
	// The status and headers are the last response's: a resume round's carry
	// no ETag, and none is carried over from an earlier one.
	return done(answer);
}

/**
 * Reads one representation per input item from
 * `GET {deliveryUrl}/v1/{manifest}{route}` and outputs it as it is: each slot
 * at its name, plus `$metadata`. A route with no representation fails the item.
 * With If-None-Match or Include Response Headers set, see answerJson.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const { route, request } = itemRequest.call(this, itemIndex);
		const resume: ResumeSettings | undefined = this.getNodeParameter('resumePartial', itemIndex, false)
			? {
					maxRounds: Number(this.getNodeParameter('maxResumeRounds', itemIndex, 3)),
					maxWaitMs: Number(this.getNodeParameter('maxResumeWaitMs', itemIndex, 5000)),
				}
			: undefined;
		const ifNoneMatch = this.getNodeParameter('ifNoneMatch', itemIndex, '');
		const revalidate: RevalidateSettings = {
			ifNoneMatch: typeof ifNoneMatch === 'string' && ifNoneMatch.trim() ? ifNoneMatch : undefined,
			includeHeaders: this.getNodeParameter('includeResponseHeaders', itemIndex, false) === true,
		};
		const representation = await readRepresentation.call(this, route, itemIndex, creds, request, resume, revalidate);
		if (representation instanceof Error) {
			if (!this.continueOnFail()) throw representation;
			results.push({
				json: {
					route: route as IDataObject[string],
					error: representation.message,
					...(representation.description && { description: representation.description }),
				},
				pairedItem: { item: itemIndex },
			});
		} else {
			results.push({ json: answerJson(representation, revalidate.includeHeaders), pairedItem: { item: itemIndex } });
		}
	}

	return results;
}
