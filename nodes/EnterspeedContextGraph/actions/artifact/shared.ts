import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { INGEST_API_VERSION } from '../entity/shared';

/** `{ingestUrl}/v1/sources/{alias}/artifacts`, the artifact drop (*Ingest artifact* spec). */
export const artifactsUrl = (creds: ContextGraphCredentials, source: string) =>
	`${creds.ingestUrl}/${INGEST_API_VERSION}/sources/${encodeURIComponent(source)}/artifacts`;

/** Every artifact refusal's problem `type` starts with this (*Ingest artifact* spec, Refusals). */
const PROBLEM_TYPE_PREFIX = 'urn:enterspeed:problem:artifact:';

export function asObject(value: unknown): IDataObject | undefined {
	if (typeof value === 'string') {
		try {
			return asObject(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : undefined;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * The parts of a refusal's problem details (`application/problem+json`) a
 * sender can act on: the reason from its `type` (e.g. `push-source`), and the
 * platform's `title` and `detail`.
 */
export function problemDetails(data: unknown): { reason?: string; title?: string; detail?: string } {
	const body = asObject(data);
	if (!body) return {};
	const type = text(body.type);
	return {
		reason: type?.startsWith(PROBLEM_TYPE_PREFIX) ? type.slice(PROBLEM_TYPE_PREFIX.length) : undefined,
		title: text(body.title),
		detail: text(body.detail),
	};
}

/**
 * Turns a failed artifact request into a node error. A refusal is named by its
 * problem type and the platform's own title, with its detail as the
 * description. The API key and the file's content are never included.
 */
export function ingestError(
	this: IExecuteFunctions,
	error: unknown,
	creds: ContextGraphCredentials,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	const { status, data } = httpFailure(error);
	// No status means no answer at all.
	if (status === undefined) {
		return new NodeOperationError(this.getNode(), `Couldn't reach the Ingest URL (${creds.ingestUrl}).`, {
			description: (error as Error).message,
			itemIndex,
		});
	}
	const { reason, title, detail } = problemDetails(data);
	let message: string;
	if (title && reason) message = `${title} (${reason})`;
	else if (title) message = title;
	else if (status === 401) message = 'The API key was rejected by the Ingest URL.';
	// A 403 without a problem body is a key without Write scope (ingest ADR 011).
	else if (status === 403) message = "The API key isn't allowed to write to this Context Graph.";
	else message = `The Ingest URL answered with status ${status}.`;

	const httpCode = String(status);
	// A plain object, not the request's own error: NodeApiError hands back an
	// existing NodeApiError unchanged, which would drop this message.
	return new NodeApiError(this.getNode(), { httpCode }, { message, description: detail, httpCode, itemIndex });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const blank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());

/**
 * The item's Source (and Artifact ID, when the operation names one) as text,
 * or the error that fails the item before anything is sent.
 */
export function readTarget(
	this: IExecuteFunctions,
	itemIndex: number,
	withId: boolean,
): { source: string; id: string } | NodeOperationError {
	const fail = (problem: string) =>
		new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });
	const source = this.getNodeParameter('sourceAlias', itemIndex, undefined);
	if (blank(source)) return fail('has no Source');
	if (typeof source !== 'string') return fail('has a Source that is not text');
	if (!withId) return { source, id: '' };
	const id = this.getNodeParameter('artifactId', itemIndex, undefined);
	if (blank(id)) return fail('has no Artifact ID');
	if (typeof id !== 'string') return fail('has an Artifact ID that is not text');
	// The routes take only a GUID; anything else answers a bare 404 that names nothing.
	if (!GUID.test(id.trim())) return fail('has an Artifact ID that is not an artifact ID (a GUID)');
	return { source, id: id.trim() };
}

/** `GET` on an artifact route with the Ingest API Key; a refusal becomes the node error that names it. */
export async function ingestGet(
	this: IExecuteFunctions,
	url: string,
	qs: IDataObject,
	creds: ContextGraphCredentials,
	itemIndex: number,
): Promise<IDataObject> {
	let response: unknown;
	try {
		response = await contextGraphApiRequest.call(this, { method: 'GET', url, qs, json: true });
	} catch (error) {
		throw ingestError.call(this, error, creds, itemIndex);
	}
	const body = asObject(response);
	if (!body) {
		throw new NodeOperationError(this.getNode(), "The Ingest URL didn't answer with an artifact or a listing.", {
			itemIndex,
		});
	}
	return body;
}

/**
 * Runs a read once per input item and outputs what it returns, each paired to
 * its item. With Continue On Fail a failed item comes out as
 * `{ source, id?, error, description? }` and the next one runs.
 */
export async function readEachItem(
	this: IExecuteFunctions,
	withId: boolean,
	read: (itemIndex: number, target: { source: string; id: string }) => Promise<IDataObject[]>,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const target = readTarget.call(this, itemIndex, withId);
			if (target instanceof NodeOperationError) throw target;
			const answered = await read(itemIndex, target);
			results.push(...answered.map((json) => ({ json, pairedItem: { item: itemIndex } })));
		} catch (error) {
			const nodeError =
				error instanceof NodeApiError || error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			if (!this.continueOnFail()) throw nodeError;
			const { message, description } = nodeError;
			// A parameter may be the expression that failed: it is left out rather than read again.
			const param = (name: string) => {
				try {
					return this.getNodeParameter(name, itemIndex, undefined) as IDataObject[string];
				} catch {
					return undefined;
				}
			};
			const source = param('sourceAlias');
			const id = withId ? param('artifactId') : undefined;
			results.push({
				json: {
					...(source !== undefined && { source }),
					...(id !== undefined && { id }),
					error: message,
					...(description && { description }),
				},
				pairedItem: { item: itemIndex },
			});
		}
	}
	return results;
}

/** Return All and Limit, shown for the given operation. */
export function pagingProperties(operation: string, limit: { maxValue?: number }): INodeProperties[] {
	const show = { resource: ['artifact'], operation: [operation] };
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1, ...limit },
			default: 50,
			description: 'Max number of results to return',
			displayOptions: { show: { ...show, returnAll: [false] } },
		},
	];
}

/** The Limit parameter as a whole number of 1 or more, or the error that fails the item. */
export function readLimit(this: IExecuteFunctions, itemIndex: number, max?: number): number {
	const limit = Number(this.getNodeParameter('limit', itemIndex, 50));
	if (!Number.isSafeInteger(limit) || limit < 1 || (max !== undefined && limit > max)) {
		const range = max === undefined ? 'of 1 or more' : `from 1 to ${max}`;
		throw new NodeOperationError(this.getNode(), `Item ${itemIndex} has a Limit that is not a whole number ${range}.`, {
			itemIndex,
		});
	}
	return limit;
}
