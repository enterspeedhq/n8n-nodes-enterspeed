import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { parseClassedField } from '../schema/msd';

const show = { resource: ['index'], operation: ['query'] };
const fromBuilder = { ...show, queryFrom: ['builder'] };
const fromJson = { ...show, queryFrom: ['json'] };

/**
 * The largest page a query may ask for. A platform-wide constant (delivery/ADR-037,
 * sc-12248 amendment: default 20, maximum 100; a direct `/query` asking for more is a
 * `400`), published in every MSD as `queryLimits.max` (delivery/ADR-036, same amendment).
 */
export const QUERY_LIMIT_MAX = 100;

const QUERY_REFERENCE_URL ='https://github.com/enterspeedhq/n8n-nodes-enterspeed#index--query';

// What the Query field starts with: a working query to edit, not an empty field.
const EXAMPLE_QUERY = JSON.stringify(
	{
		index: 'ProductIndex',
		filters: {
			and: [
				{ field: 'inStock', operator: 'equals', value: true },
				{
					or: [
						{ field: 'price', operator: 'lessThan', value: 3000 },
						{ field: 'categoryId', operator: 'equals', value: 'cat-headphones' },
					],
				},
			],
		},
		sort: [{ field: 'price', direction: 'desc' }],
		limit: 20,
		page: 0,
	},
	null,
	2,
);

export const properties: INodeProperties[] = [
	{
		displayName: 'Query From',
		name: 'queryFrom',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Builder',
				value: 'builder',
				description: "Choose the index, fields and operators from the manifest's schema",
			},
			{ name: 'JSON', value: 'json', description: 'Write the whole query as JSON' },
		],
		default: 'json',
		description: 'How the query is given',
		displayOptions: { show },
	},
	{
		displayName: 'Index Name or ID',
		name: 'builderIndex',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getIndexes' },
		default: '',
		required: true,
		description: 'The index to query, from the schema of the manifest. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: fromBuilder },
	},
	{
		displayName: 'Search',
		name: 'search',
		type: 'string',
		default: '',
		placeholder: 'e.g. wireless headphones',
		description: "Text to match against the index's searchable fields. Leave empty for no search.",
		displayOptions: { show: fromBuilder },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		placeholder: 'Add Filter',
		description: 'Conditions every match meets, all of them',
		displayOptions: { show: fromBuilder },
		options: [
			{
				displayName: 'Filter',
				name: 'filter',
				values: [
					{
						displayName: 'Field Name or ID',
						name: 'field',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getFilterFields', loadOptionsDependsOn: ['builderIndex'] },
						default: '',
						description: 'A field the index can filter on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Operator Name or ID',
						name: 'operator',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getFilterOperators' },
						default: '',
						description: 'One of the schema\'s filter operators. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'The value to compare with. For "in", separate the values with commas.',
					},
				],
			},
		],
	},
	{
		displayName: 'Sort',
		name: 'sort',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		placeholder: 'Add Sort',
		description: 'The order of the matches, first sort first',
		displayOptions: { show: fromBuilder },
		options: [
			{
				displayName: 'Sort',
				name: 'sortBy',
				values: [
					{
						displayName: 'Field Name or ID',
						name: 'field',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getSortFields', loadOptionsDependsOn: ['builderIndex'] },
						default: '',
						description: 'A field the index declares sortable, as the schema lists them; a sort on any other field is refused. If the list is empty, the schema lists no sortable fields for this index. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Order',
						name: 'order',
						type: 'options',
						options: [
							{ name: 'Ascending', value: 'asc' },
							{ name: 'Descending', value: 'desc' },
						],
						default: 'asc',
						description: 'Lowest or highest first',
					},
				],
			},
		],
	},
	{
		displayName: 'Results Per Page',
		name: 'queryLimit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: QUERY_LIMIT_MAX },
		default: 20,
		description: `How many matches per page, at most ${QUERY_LIMIT_MAX}: the Context Graph refuses a larger page for the whole request`,
		displayOptions: { show: fromBuilder },
	},
	{
		displayName: 'Page',
		name: 'page',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		description: 'Which page of matches, from 0',
		displayOptions: { show: fromBuilder },
	},
	{
		displayName: 'Query ID',
		name: 'queryId',
		type: 'string',
		default: '',
		description: "Labels the query's result. Leave empty to use its position in the request.",
		displayOptions: { show: fromBuilder },
	},
	{
		displayName:
			'Each input item is one query. All items are sent in one request, and each item gets back its result unchanged: items, totalCount and next. Edit the example below to fit your index.',
		name: 'queryNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: fromJson },
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'json',
		default: EXAMPLE_QUERY,
		required: true,
		displayOptions: { show: fromJson },
		hint: `Only index is required. Every member (filters, sort, limit, page, cursor, search, aggregations, args), the operators and paging: <a href="${QUERY_REFERENCE_URL}" target="_blank">Query reference</a>. An optional "id" labels the query's result (else its position in the request); two queries in one run can't share one.`,
		// Also what an AI Agent reads when it fills this field ($fromAI), so it states the whole format.
		description:
			'A Context Graph query as a JSON object, sent as written. "index" (required): the index shape name. "filters": { "field", "operator", "value" } or { "and": [...] } / { "or": [...] }, nested freely; operators: equals, notEquals, greaterThan, greaterThanOrEquals, lessThan, lessThanOrEquals, contains, in (value is a list). "sort": [{ "field", "direction": "asc" | "desc" }]. "limit": results per page, up to 100 (default 20). "page": from 0. "cursor": the previous result\'s "next". "search": { "query", "literal"?, "fields"?, "language"? }. "aggregations": [{ "type": "values" | "metrics" | "range", "name", "field", "size"?, "ranges"? }]. "args": values for ${token} placeholders. Only fields the index declares as filterable or sortable can be filtered or sorted on.',
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

/** A filter value as its field's value class takes it (delivery/ADR-037: filters are validated by value class). */
function filterValue(value: string, valueClass: string | undefined, operator: string): unknown {
	const typed = (v: string): unknown => {
		if (valueClass === 'numeric' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
		if (valueClass === 'boolean' && (v === 'true' || v === 'false')) return v === 'true';
		return v;
	};
	// "in" takes a list of scalars.
	return operator.toLowerCase() === 'in' ? value.split(',').map((v) => typed(v.trim())) : typed(value);
}

/**
 * A sort's direction in the contract's own words (*Query sort order*: `asc` or
 * `desc`). A workflow saved before the field took `asc`/`desc` holds
 * `Ascending`/`Descending`, read the same.
 */
const sortDirection = (order: string | undefined): 'asc' | 'desc' =>
	order?.toLowerCase().startsWith('desc') ? 'desc' : 'asc';

/**
 * The query the builder's fields describe, in the /query wire form
 * (delivery/ADR-037): filters AND-combined, each sort as `direction`
 * `asc` or `desc` (*Query sort order* contract). Empty fields are left out.
 */
export function builderQuery(fields: {
	index: string;
	search?: string;
	filters?: Array<{ field?: string; operator?: string; value?: string }>;
	sort?: Array<{ field?: string; order?: string }>;
	limit?: number;
	page?: number;
	id?: string;
}): IDataObject {
	const query: IDataObject = { index: fields.index };
	if (fields.id) query.id = fields.id;
	if (fields.search) query.search = { query: fields.search };
	const filters = (fields.filters ?? [])
		.filter((f) => f.field && f.operator)
		.map((f) => {
			const { valueClass, field } = parseClassedField(f.field as string);
			return { field, operator: f.operator as string, value: filterValue(f.value ?? '', valueClass, f.operator as string) };
		});
	if (filters.length === 1) query.filters = filters[0] as IDataObject;
	else if (filters.length) query.filters = { and: filters as IDataObject[] };
	const sort = (fields.sort ?? [])
		.filter((s) => s.field)
		.map((s) => ({ field: parseClassedField(s.field as string).field, direction: sortDirection(s.order) }));
	if (sort.length) query.sort = sort;
	if (fields.limit !== undefined) query.limit = fields.limit;
	if (fields.page) query.page = fields.page;
	return query;
}

function fromBuilderFields(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const index = this.getNodeParameter('builderIndex', itemIndex, '');
	if (typeof index !== 'string' || !index.trim()) throw new NodeOperationError(this.getNode(), 'Query has no index.');
	// The editor stops a larger number, but an expression can still give one. Failing this
	// item here keeps the platform from refusing the whole request with a 400.
	const limit = this.getNodeParameter('queryLimit', itemIndex, 20);
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT_MAX) {
		throw new NodeOperationError(
			this.getNode(),
			`Results Per Page must be a whole number from 1 to ${QUERY_LIMIT_MAX} (got ${JSON.stringify(limit)}).`,
		);
	}
	const filters = this.getNodeParameter('filters.filter', itemIndex, []) as Array<{ field?: string; operator?: string; value?: string }>;
	const sort = this.getNodeParameter('sort.sortBy', itemIndex, []) as Array<{ field?: string; order?: string }>;
	return builderQuery({
		index,
		search: this.getNodeParameter('search', itemIndex, '') as string,
		filters,
		sort,
		limit,
		page: this.getNodeParameter('page', itemIndex, 0) as number,
		id: this.getNodeParameter('queryId', itemIndex, '') as string,
	});
}

/** The item's query, as written. Only its index is checked; the rest is the platform's to judge. */
function buildQuery(this: IExecuteFunctions, itemIndex: number): IDataObject {
	if (this.getNodeParameter('queryFrom', itemIndex, 'json') === 'builder') return fromBuilderFields.call(this, itemIndex);
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

/**
 * Fails the batch, before sending, when two queries would get the same id.
 * The platform rejects such a batch with a 400 (query-envelope contract,
 * "Response ids are unique across the batch"); the dev-server doesn't check
 * yet, so the node does, to fail the same way against both.
 */
function checkDistinctIds(this: IExecuteFunctions, queries: Array<{ itemIndex: number; id: string }>): void {
	const seen = new Map<string, number>();
	for (const { itemIndex, id } of queries) {
		const first = seen.get(id);
		if (first !== undefined) {
			throw new NodeOperationError(
				this.getNode(),
				`Items ${first} and ${itemIndex} both have the query id "${id}". Each query in a run needs its own id.`,
			);
		}
		seen.set(id, itemIndex);
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
	// An invalid query or unknown manifest: the platform says which. An unknown
	// index isn't an error: delivery answers it with an empty result.
	else if (own) message = own;
	else message = `The Delivery URL answered with status ${status}.`;
	const httpCode = String(status);
	// A plain object, not the request's own error: NodeApiError hands back an
	// existing NodeApiError unchanged, which would drop this message.
	return new NodeApiError(this.getNode(), { httpCode }, { message, httpCode });
}

/**
 * Sends every item's query to `POST {deliveryUrl}/query/v1/{manifest}` in one
 * request (delivery/ADR-030 §3), as written, and outputs each query's result
 * unchanged, paired to its item by id: the query's own, else its position in
 * the request (query-envelope contract). The platform rejects the whole batch
 * when one query is invalid, so a failed request fails every query in it.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];
	const queries: Array<{ itemIndex: number; id: string; query: IDataObject }> = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const query = buildQuery.call(this, itemIndex);
			// The platform's own rule: the query's id if it has one, else its position in the request.
			const id = query.id === undefined || query.id === null ? String(queries.length) : String(query.id);
			queries.push({ itemIndex, id, query });
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
			checkDistinctIds.call(this, queries);
			response = await contextGraphApiRequest.call(this, {
				method: 'POST',
				url,
				body: queries.map((q) => q.query),
				json: true,
			});
		} catch (error) {
			const nodeError =
				error instanceof NodeOperationError ? error : requestError.call(this, error, url);
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
		for (const { itemIndex, id } of queries) {
			const answer = answers.get(id);
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
