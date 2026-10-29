import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';

const show = { resource: ['index'], operation: ['query'] };

const QUERY_REFERENCE_URL = 'https://github.com/enterspeedhq/n8n-nodes-enterspeed#index--query';

export const properties: INodeProperties[] = [
	{
		displayName:
			'Each input item is one query. All items are sent in one request, and each item gets back its result unchanged: items, totalCount and next.<br><br>Example: <code>{ "index": "ProductIndex", "filters": { "field": "inStock", "operator": "equals", "value": true }, "sort": [{ "field": "price", "order": "desc" }], "limit": 20 }</code>',
		name: 'queryNotice',
		type: 'notice',
		default: '',
		displayOptions: { show },
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'json',
		default: '',
		required: true,
		hint: `Only index is required. Every member (filters, sort, limit, page, cursor, search, aggregations, args), the operators and paging: <a href="${QUERY_REFERENCE_URL}" target="_blank">Query reference</a>.`,
		// Also what an AI Agent reads when it fills this field ($fromAI), so it states the whole format.
		description:
			'A Context Graph query as a JSON object, sent as written. "index" (required): the index shape name. "filters": { "field", "operator", "value" } or { "and": [...] } / { "or": [...] }, nested freely; operators: equals, notEquals, greaterThan, greaterThanOrEquals, lessThan, lessThanOrEquals, contains, in (value is a list). "sort": [{ "field", "order": "asc" | "desc" }]. "limit": results per page, up to 100 (default 20). "page": from 0. "cursor": the previous result\'s "next". "search": { "query", "literal"?, "fields"?, "language"? }. "aggregations": [{ "type": "values" | "metrics" | "range", "name", "field", "size"?, "ranges"? }]. "args": values for ${token} placeholders. Only fields the index declares as filterable or sortable can be filtered or sorted on.',
		displayOptions: { show },
	},
];

const isObject = (value: unknown): value is IDataObject =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** A JSON parameter's value, parsed if it was typed in as text. */
function parseJson(this: IExecuteFunctions, value: unknown, name: string): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new NodeOperationError(this.getNode(), `${name} is not valid JSON.`);
	}
}

/** The item's query, as written. Only its index is checked; the rest is the platform's to judge. */
function buildQuery(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const raw = this.getNodeParameter('query', itemIndex, '');
	if (typeof raw === 'string' && raw.trim() === '') throw new NodeOperationError(this.getNode(), 'Query is empty.');
	const query = parseJson.call(this, raw, 'Query');
	if (!isObject(query)) throw new NodeOperationError(this.getNode(), 'Query must be a JSON object.');
	if (typeof query.index !== 'string' || query.index.trim() === '') {
		throw new NodeOperationError(this.getNode(), 'Query has no index.');
	}
	return query;
}

/** The platform's own message from a failed answer's body, when it has one. */
function platformMessage(data: unknown): string | undefined {
	const body = typeof data === 'string' ? (parseOrUndefined(data) ?? data) : data;
	if (isObject(body) && typeof body.message === 'string') return body.message;
	return typeof body === 'string' && body.trim() ? body : undefined;
}

function parseOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function requestError(this: IExecuteFunctions, error: unknown, url: string): NodeApiError | NodeOperationError {
	const { status, data } = httpFailure(error);
	if (status === undefined) {
		return new NodeOperationError(this.getNode(), `Couldn't reach the Delivery URL (${url}).`, {
			description: (error as Error).message,
		});
	}
	const own = platformMessage(data);
	let message: string;
	if (status === 401) message = 'The API key was rejected by the Delivery URL.';
	// An invalid query, unknown index or unknown manifest: the platform says which.
	else if (own) message = own;
	else message = `The Delivery URL answered with status ${status}.`;
	const httpCode = String(status);
	// A plain object, not the request's own error: NodeApiError hands back an
	// existing NodeApiError unchanged, which would drop this message.
	return new NodeApiError(this.getNode(), { httpCode }, { message, httpCode });
}

/**
 * Sends every item's query to `POST {deliveryUrl}/query/v1/{manifest}` in one
 * request (delivery/ADR-030 §3), each with the item's position as its `id`,
 * and outputs each query's result unchanged (query-envelope contract), paired
 * to its item. The platform rejects the whole batch when one query is
 * invalid, so a failed request fails every query in it.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];
	const queries: Array<{ itemIndex: number; query: IDataObject }> = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			queries.push({ itemIndex, query: { ...buildQuery.call(this, itemIndex), id: String(itemIndex) } });
		} catch (error) {
			const message = `Item ${itemIndex}: ${(error as Error).message}`;
			if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), message, { itemIndex });
			results[itemIndex] = { json: { error: message }, pairedItem: { item: itemIndex } };
		}
	}

	if (queries.length) {
		const url = `${creds.deliveryUrl}/query/v1/${encodeURIComponent(creds.manifestVersion)}`;
		let response: unknown;
		try {
			response = await contextGraphApiRequest.call(this, {
				method: 'POST',
				url,
				body: queries.map((q) => q.query),
				json: true,
			});
		} catch (error) {
			const nodeError = requestError.call(this, error, url);
			if (!this.continueOnFail()) throw nodeError;
			for (const { itemIndex } of queries) {
				results[itemIndex] = {
					json: { error: nodeError.message, description: nodeError.description ?? undefined },
					pairedItem: { item: itemIndex },
				};
			}
			return results.filter(Boolean);
		}

		const answers = new Map<string, IDataObject>();
		for (const answer of Array.isArray(response) ? response : []) {
			if (isObject(answer)) answers.set(String(answer.id), answer);
		}
		for (const { itemIndex } of queries) {
			const answer = answers.get(String(itemIndex));
			if (answer) results[itemIndex] = { json: answer, pairedItem: { item: itemIndex } };
			else {
				const message = `Item ${itemIndex}: the Delivery URL returned no result for this query.`;
				if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), message, { itemIndex });
				results[itemIndex] = { json: { error: message }, pairedItem: { item: itemIndex } };
			}
		}
	}

	return results.filter(Boolean);
}
