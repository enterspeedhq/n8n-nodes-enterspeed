import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';

const show = { resource: ['index'], operation: ['query'] };
const showFields = { ...show, specifyQuery: ['fields'] };

export const properties: INodeProperties[] = [
	{
		displayName:
			'Each input item is one query. All items are sent in one request, and each item gets back its result unchanged, as the Context Graph returns it, with its items, totalCount and next. For the next page, pass next back as Cursor, or raise Page.',
		name: 'queryNotice',
		type: 'notice',
		default: '',
		displayOptions: { show },
	},
	{
		displayName: 'Index',
		name: 'index',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. ProductIndex',
		description: 'The name of the index shape to query',
		displayOptions: { show },
	},
	{
		displayName: 'Specify Query',
		name: 'specifyQuery',
		type: 'options',
		options: [
			{ name: 'Using Fields', value: 'fields' },
			{ name: 'Using JSON', value: 'json' },
		],
		default: 'fields',
		description: 'Whether to build the query from the fields below or write it as JSON',
		displayOptions: { show },
	},
	{
		displayName: 'Filters Combinator',
		name: 'filtersCombinator',
		type: 'options',
		options: [
			{ name: 'AND', value: 'and' },
			{ name: 'OR', value: 'or' },
		],
		default: 'and',
		description: 'How the filter conditions below are combined. For nested AND/OR groups, use "Using JSON".',
		displayOptions: { show: showFields },
	},
	{
		displayName: 'Filters',
		name: 'filtersUi',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		placeholder: 'Add Filter',
		description: 'Conditions on fields the index declares as filterable',
		displayOptions: { show: showFields },
		options: [
			{
				name: 'condition',
				displayName: 'Condition',
				values: [
					{ displayName: 'Field', name: 'field', type: 'string', default: '', description: 'The index field to filter on' },
					{
						displayName: 'Operator',
						name: 'operator',
						type: 'options',
						options: [
							{ name: 'Contains', value: 'contains' },
							{ name: 'Equals', value: 'equals' },
							{ name: 'Greater Than', value: 'greaterThan' },
							{ name: 'Greater Than Or Equals', value: 'greaterThanOrEquals' },
							{ name: 'In', value: 'in' },
							{ name: 'Less Than', value: 'lessThan' },
							{ name: 'Less Than Or Equals', value: 'lessThanOrEquals' },
							{ name: 'Not Equals', value: 'notEquals' },
						],
						default: 'equals',
						description: 'How the field is compared with the value',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description:
							'Sent as a number, true/false or list when written as JSON (1000, true, ["a","b"]), otherwise as text. "In" takes a list.',
					},
				],
			},
		],
	},
	{
		displayName: 'Sort',
		name: 'sortUi',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		placeholder: 'Add Sort Field',
		description: 'Fields the index declares as sortable, in order of priority',
		displayOptions: { show: showFields },
		options: [
			{
				name: 'item',
				displayName: 'Sort',
				values: [
					{ displayName: 'Field', name: 'field', type: 'string', default: '', description: 'The index field to sort by' },
					{
						displayName: 'Order',
						name: 'order',
						type: 'options',
						options: [
							{ name: 'Ascending', value: 'asc' },
							{ name: 'Descending', value: 'desc' },
						],
						default: 'asc',
						description: 'The sort direction',
					},
				],
			},
		],
	},
	{
		displayName: 'Page Size',
		name: 'pageSize',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 100 },
		default: 20,
		description: 'How many results each page holds (sent as limit). The Context Graph allows up to 100.',
		displayOptions: { show: showFields },
	},
	{
		displayName: 'Page',
		name: 'page',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		description: 'The page to return, counted from 0',
		displayOptions: { show: showFields },
	},
	{
		displayName: 'Cursor',
		name: 'cursor',
		type: 'string',
		default: '',
		description: 'The next value from the previous page, to get the page after it. Leave empty for the first page.',
		displayOptions: { show: showFields },
	},
	{
		displayName: 'Options',
		name: 'queryOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: showFields },
		options: [
			{
				displayName: 'Aggregations (JSON)',
				name: 'aggregations',
				type: 'json',
				default: '[]',
				description: 'A list of { type: "values" | "metrics" | "range", name, field, size?, ranges? }',
			},
			{
				displayName: 'Args (JSON)',
				name: 'args',
				type: 'json',
				default: '{}',
				description: 'Values for the ${token} placeholders in the filters and search, by name',
			},
			{
				displayName: 'Search Fields',
				name: 'searchFields',
				type: 'string',
				default: '',
				description: 'Comma-separated searchable fields to search in. Leave empty to search every one.',
			},
			{
				displayName: 'Search Language',
				name: 'searchLanguage',
				type: 'string',
				default: '',
				description: 'Search only fields that declare this language',
			},
			{
				displayName: 'Search Literal',
				name: 'searchLiteral',
				type: 'boolean',
				default: false,
				description: 'Whether to turn fuzzy matching off, e.g. for SKU and code lookups',
			},
			{
				displayName: 'Search Text',
				name: 'searchQuery',
				type: 'string',
				default: '',
				description: 'Full-text search across the index\'s searchable fields',
			},
		],
	},
	{
		displayName: 'Query (JSON)',
		name: 'queryJson',
		type: 'json',
		default: '{\n  "limit": 20\n}',
		description:
			'The query without its index: filters, sort, limit, page, cursor, search, aggregations and args. All are optional.',
		displayOptions: { show: { ...show, specifyQuery: ['json'] } },
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

/** A filter value: JSON when it reads as JSON (a number, true/false, a list), otherwise the text. */
function filterValue(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** The query for one item, from the fields or the JSON, with the index set. */
function buildQuery(this: IExecuteFunctions, itemIndex: number): IDataObject {
	const index = this.getNodeParameter('index', itemIndex, '');
	if (typeof index !== 'string' || index.trim() === '') throw new NodeOperationError(this.getNode(), 'Index is empty.');

	if (this.getNodeParameter('specifyQuery', itemIndex, 'fields') === 'json') {
		const json = parseJson.call(this, this.getNodeParameter('queryJson', itemIndex, '{}'), 'Query (JSON)');
		if (!isObject(json)) throw new NodeOperationError(this.getNode(), 'Query (JSON) must be an object.');
		return { ...json, index };
	}

	const query: IDataObject = { index };

	const conditions = (this.getNodeParameter('filtersUi.condition', itemIndex, []) as IDataObject[]).map((c) => ({
		field: c.field,
		operator: c.operator,
		value: filterValue(c.value),
	}));
	if (conditions.length === 1) query.filters = conditions[0];
	else if (conditions.length > 1) {
		query.filters = { [this.getNodeParameter('filtersCombinator', itemIndex, 'and') as string]: conditions };
	}

	const sort = this.getNodeParameter('sortUi.item', itemIndex, []) as IDataObject[];
	if (sort.length) query.sort = sort.map((s) => ({ field: s.field, order: s.order }));

	query.limit = this.getNodeParameter('pageSize', itemIndex, 20);
	query.page = this.getNodeParameter('page', itemIndex, 0);
	const cursor = this.getNodeParameter('cursor', itemIndex, '');
	if (cursor) query.cursor = cursor;

	const options = this.getNodeParameter('queryOptions', itemIndex, {}) as IDataObject;
	if (options.searchQuery) {
		const fields = String(options.searchFields ?? '')
			.split(',')
			.map((f) => f.trim())
			.filter(Boolean);
		query.search = {
			query: options.searchQuery,
			...(options.searchLiteral ? { literal: true } : {}),
			...(fields.length ? { fields } : {}),
			...(options.searchLanguage ? { language: options.searchLanguage } : {}),
		};
	}
	if (options.aggregations !== undefined) {
		const aggregations = parseJson.call(this, options.aggregations, 'Aggregations (JSON)');
		if (Array.isArray(aggregations) && aggregations.length) query.aggregations = aggregations;
	}
	if (options.args !== undefined) {
		const args = parseJson.call(this, options.args, 'Args (JSON)');
		if (isObject(args) && Object.keys(args).length) query.args = args;
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
