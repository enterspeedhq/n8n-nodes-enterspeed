import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	IHttpRequestMethods,
	IHttpRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

const MAX_BULK_ENTITIES = 50;
const MAX_MULTI_QUERIES = 5;

/**
 * Fields shared by "Query Items" and each entry of "Multi Query Items".
 * `specifyQueryDefault` differs between the two: existing saved workflows for
 * the single-query operation have no stored value for `specifyQuery`, so its
 * default there must stay 'json' to preserve their current raw-body behavior.
 */
function buildQueryFields(specifyQueryDefault: 'fields' | 'json'): INodeProperties[] {
	return [
		{
			displayName: 'Specify Query',
			name: 'specifyQuery',
			type: 'options',
			options: [
				{ name: 'Using Fields', value: 'fields' },
				{ name: 'Using JSON', value: 'json' },
			],
			default: specifyQueryDefault,
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
			displayOptions: { show: { specifyQuery: ['fields'] } },
			description:
				'How the filter conditions below are combined. For deeper nested AND/OR groups, use "Using JSON" instead.',
		},
		{
			displayName: 'Filters',
			name: 'filtersUi',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			placeholder: 'Add Filter',
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					name: 'condition',
					displayName: 'Condition',
					values: [
						{ displayName: 'Field', name: 'field', type: 'string', default: '' },
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
						},
						{
							displayName: 'Value',
							name: 'value',
							type: 'string',
							default: '',
							description: 'For "In", use a comma-separated list',
						},
						{ displayName: 'Case Insensitive', name: 'caseInsensitive', type: 'boolean', default: false },
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
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					name: 'item',
					displayName: 'Sort',
					values: [
						{ displayName: 'Field', name: 'field', type: 'string', default: '' },
						{
							displayName: 'Order',
							name: 'order',
							type: 'options',
							options: [
								{ name: 'Ascending', value: 'asc' },
								{ name: 'Descending', value: 'desc' },
							],
							default: 'desc',
						},
					],
				},
			],
		},
		{
			displayName: 'Facets',
			name: 'facetsUi',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			placeholder: 'Add Facet',
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					name: 'item',
					displayName: 'Facet',
					values: [
						{ displayName: 'Field', name: 'field', type: 'string', required: true, default: '' },
						{
							displayName: 'Name',
							name: 'name',
							type: 'string',
							default: '',
							description: 'Defaults to the field name',
						},
						{
							displayName: 'Size',
							name: 'size',
							type: 'number',
							default: 10,
							typeOptions: { minValue: 1, maxValue: 100 },
						},
					],
				},
			],
		},
		{
			displayName: 'Options',
			name: 'queryOptions',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					displayName: 'Aliases',
					name: 'aliases',
					type: 'string',
					default: '',
					description: 'Comma-separated view aliases to include, e.g. productTile',
				},
				{ displayName: 'Literal Match', name: 'searchLiteral', type: 'boolean', default: false },
				// eslint-disable-next-line n8n-nodes-base/node-param-type-options-password-missing -- pagination cursor, not a secret
				{ displayName: 'Next Page Token', name: 'nextPageToken', type: 'string', default: '' },
				{ displayName: 'Page', name: 'page', type: 'number', default: 0, typeOptions: { minValue: 0 } },
				{
					displayName: 'Page Size',
					name: 'pageSize',
					type: 'number',
					default: 10,
					typeOptions: { minValue: 1, maxValue: 1000 },
				},
				{ displayName: 'Search Field', name: 'searchField', type: 'string', default: '' },
				{ displayName: 'Search Value', name: 'searchValue', type: 'string', default: '' },
			],
		},
		{
			displayName: 'Query Body (JSON)',
			name: 'queryBody',
			type: 'json',
			default: '{\n  "pagination": { "page": 1, "size": 10 }\n}',
			displayOptions: { show: { specifyQuery: ['json'] } },
			description: 'Filters, sort, pagination and facets. All properties optional.',
		},
	];
}

/** Merges a resource/operation guard into each field's own displayOptions.show. */
function withDisplayGuard(fields: INodeProperties[], guard: Record<string, string[]>): INodeProperties[] {
	return fields.map((field) => ({
		...field,
		displayOptions: {
			...field.displayOptions,
			show: { ...guard, ...(field.displayOptions?.show ?? {}) },
		},
	}));
}

/**
 * Assembles the Enterspeed Query API body from the structured "Using Fields"
 * parameters. Shared by the single Query Items operation and each entry of
 * Multi Query Items, since both expose the same field group.
 */
function buildQueryPayload(fields: IDataObject): IDataObject {
	const body: IDataObject = {};

	const conditions = ((fields.filtersUi as IDataObject)?.condition as IDataObject[]) ?? [];
	if (conditions.length) {
		const combinator = (fields.filtersCombinator as string) === 'or' ? 'or' : 'and';
		body.filters = {
			[combinator]: conditions.map((c) => ({
				field: c.field,
				operator: c.operator,
				value: c.value,
				...(c.caseInsensitive ? { caseInsensitive: true } : {}),
			})),
		};
	}

	const sortItems = ((fields.sortUi as IDataObject)?.item as IDataObject[]) ?? [];
	if (sortItems.length) {
		body.sort = sortItems.map((s) => ({ field: s.field, order: s.order }));
	}

	const facetItems = ((fields.facetsUi as IDataObject)?.item as IDataObject[]) ?? [];
	if (facetItems.length) {
		body.facets = facetItems.map((f) => ({
			field: f.field,
			...(f.name ? { name: f.name } : {}),
			size: f.size,
		}));
	}

	const options = (fields.queryOptions as IDataObject) ?? {};
	if (options.searchField) {
		body.search = {
			field: options.searchField,
			value: options.searchValue,
			literal: Boolean(options.searchLiteral),
		};
	}

	const pagination: IDataObject = {};
	if (options.page !== undefined && options.page !== '') pagination.page = options.page;
	if (options.pageSize !== undefined && options.pageSize !== '') pagination.pageSize = options.pageSize;
	if (options.nextPageToken) pagination.nextPageToken = options.nextPageToken;
	if (Object.keys(pagination).length) body.pagination = pagination;

	if (options.aliases) {
		const aliases = (options.aliases as string)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (aliases.length) body.aliases = aliases;
	}
	
	return body;
}

/**
 * Enterspeed action node.
 *
 * Resources:
 *  - Entity   (Ingest API)   : save / delete a source entity
 *  - Delivery (Delivery API) : get content by URL, IDs or handles
 *  - Query    (Query API)    : query an index
 *  - Route    (Routes API)   : list all routes for an environment
 */
export class Enterspeed implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed',
		name: 'enterspeed',
		icon: 'file:enterspeed.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Ingest, deliver and query data through Enterspeed',
		defaults: { name: 'Enterspeed' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'enterspeedApi', required: true }],
		codex: {
			categories: ['Data & Storage'],
			subcategories: {
				'Data & Storage': ['Content Management'],
			},
			resources: {
				primaryDocumentation: [
					{ url: 'https://docs.enterspeed.com' },
				],
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Entity (Ingest)', value: 'entity' },
					{ name: 'Delivery', value: 'delivery' },
					{ name: 'Query', value: 'query' },
					{ name: 'Route', value: 'route' },
				],
				default: 'delivery',
			},

			// ---------- Entity ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['entity'] } },
				options: [
					{ name: 'Save', value: 'save', action: 'Save an entity', description: 'Ingest / update a source entity' },
					{ name: 'Delete', value: 'delete', action: 'Delete an entity' },
					{
						name: 'Save Entities (Bulk)',
						value: 'saveBulk',
						action: 'Save entities in bulk',
						description: `Ingest / update up to ${MAX_BULK_ENTITIES} source entities in one call`,
					},
					{
						name: 'Delete Entities (Bulk)',
						value: 'deleteBulk',
						action: 'Delete entities in bulk',
						description: `Delete up to ${MAX_BULK_ENTITIES} source entities in one call`,
					},
				],
				default: 'save',
			},
			{
				displayName: 'Origin ID',
				name: 'originId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['entity'], operation: ['save', 'delete'] } },
				description: 'Unique ID of the entity in your source system',
			},
			{
				displayName: 'Entity Type',
				name: 'entityType',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['entity'], operation: ['save'] } },
				description: 'Type/alias of the entity, e.g. product, blogPage. Immutable after first ingest.',
			},
			{
				displayName: 'Properties (JSON)',
				name: 'properties',
				type: 'json',
				required: true,
				default: '{}',
				displayOptions: { show: { resource: ['entity'], operation: ['save'] } },
				description: 'The source entity body sent to Enterspeed',
			},
			{
				displayName: 'Entities (JSON Array)',
				name: 'entities',
				type: 'json',
				default: '',
				required: true,
				hint: "See https://docs.enterspeed.com/api-reference/ingest/save-entities for entities format.",
				displayOptions: { show: { resource: ['entity'], operation: ['saveBulk'] } },
				description: 'Array of entities. Example: [ { "type": "product", "originId": "p-5427", "properties": { "name": "Official Enterspeed T-shirt" } } ].',			
			},
			{
				displayName: 'Origin IDs (JSON Array)',
				name: 'originIds',
				type: 'json',
				default: '',
				required: true,
				placeholder: JSON.stringify({ originIds: ['p-5427', 'p-6724'] }, null, 2),
				displayOptions: { show: { resource: ['entity'], operation: ['deleteBulk'] } },
				description: `Must match the Delete Entities (Bulk) API body: { "originIds": [...] }, with up to ${MAX_BULK_ENTITIES} originIds`,
			},

			// ---------- Delivery ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['delivery'] } },
				options: [
					{ name: 'Get Content', value: 'get', action: 'Get content' },
				],
				default: 'get',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['delivery'] } },
				description: 'Absolute URL to fetch a view for (optional)',
			},
			{
				displayName: 'View IDs',
				name: 'ids',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['delivery'] } },
				description: 'Comma-separated view IDs (optional)',
			},
			{
				displayName: 'Handles',
				name: 'handles',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['delivery'] } },
				description: 'Comma-separated handles, e.g. Navigation (optional)',
			},

			// ---------- Query ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['query'] } },
				options: [
					{ name: 'Query Items', value: 'query', action: 'Query items in an index' },
					{
						name: 'Multi Query Items',
						value: 'queryMulti',
						action: 'Query multiple indices in one call',
						description: `Run up to ${MAX_MULTI_QUERIES} queries in a single request`,
					},
				],
				default: 'query',
			},
			{
				displayName: 'Index Alias',
				name: 'indexAlias',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['query'], operation: ['query'] } },
				description: 'Alias of the index to query, e.g. productIndex',
			},
			...withDisplayGuard(buildQueryFields('json'), { resource: ['query'], operation: ['query'] }),
			{
				displayName: 'Specify Queries',
				name: 'specifyQuery',
				type: 'options',
				options: [
					{ name: 'Using Fields', value: 'fields' },
					{ name: 'Using JSON', value: 'json' },
				],
				default: 'fields',
				displayOptions: { show: { resource: ['query'], operation: ['queryMulti'] } },
				description:
					'Using JSON sends the full array of queries as-is — useful when it is already assembled upstream, e.g. by a Code node.',
			},
			{
				displayName: 'Queries (JSON)',
				name: 'queryBody',
				type: 'json',
				default: '',
				required: true,
				placeholder: JSON.stringify(
					[
						{ index: 'productIndex', name: 'products', pagination: { page: 1, size: 50 } },
						{ index: 'categoryIndex', name: 'categories' },
					],
					null,
					2,
				),
				displayOptions: { show: { resource: ['query'], operation: ['queryMulti'], specifyQuery: ['json'] } },
				description: `Sent to Enterspeed exactly as entered — the full array of up to ${MAX_MULTI_QUERIES} queries for POST /v1. Each item needs "index" and "name", plus any filters/sort/facets/pagination.`,
			},
			{
				displayName: 'Queries',
				name: 'queries',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Query',
				default: {},
				displayOptions: { show: { resource: ['query'], operation: ['queryMulti'], specifyQuery: ['fields'] } },
				description: `Up to ${MAX_MULTI_QUERIES} queries to run in one request`,
				options: [
					{
						name: 'query',
						displayName: 'Query',
						values: [
							{
								displayName: 'Index Alias',
								name: 'indexAlias',
								type: 'string',
								required: true,
								default: '',
								description: 'Alias of the index to query, e.g. productIndex',
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								required: true,
								default: '',
								description: 'Identifier for this query, used to match it to its result',
							},
							...buildQueryFields('fields'),
						],
					},
				],
			},

			// ---------- Route ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['route'] } },
				options: [
					{ name: 'Get Many', value: 'getAll', action: 'Get many routes for the environment' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Page Size',
				name: 'first',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 100, maxValue: 500 },
				displayOptions: { show: { resource: ['route'] } },
				description: 'Number of routes per page (100–500)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		const creds = await this.getCredentials('enterspeedApi');
		const envKey = creds.environmentApiKey as string;
		const sourceKey = creds.sourceApiKey as string;
		const ingestHost = (creds.ingestHost as string) ?? 'https://api.enterspeed.com';
		const deliveryHost = (creds.deliveryHost as string) ?? 'https://delivery.enterspeed.com';
		const queryHost = (creds.queryHost as string) ?? 'https://query.enterspeed.com';

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let options: IHttpRequestOptions;

				if (resource === 'entity') {
					if (!sourceKey) {
						throw new NodeOperationError(this.getNode(), 'Source API Key is required for ingest operations', { itemIndex: i });
					}
					if (operation === 'saveBulk' || operation === 'deleteBulk') {
						const paramName = operation === 'saveBulk' ? 'entities' : 'originIds';
						const raw = this.getNodeParameter(paramName, i) as IDataObject | IDataObject[] | string;
						const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
						if (operation === 'saveBulk') {
							if (!Array.isArray(parsed)) {
								throw new NodeOperationError(this.getNode(), `${paramName} must be a JSON array`, { itemIndex: i });
							}
						} else if (
							!parsed ||
							typeof parsed !== 'object' ||
							Array.isArray(parsed) ||
							!Array.isArray((parsed as IDataObject).originIds)
						) {
							throw new NodeOperationError(
								this.getNode(),
								`${paramName} must be a JSON object in the form { "originIds": [...] }`,
								{ itemIndex: i },
							);
						}
						options = {
							method: operation === 'saveBulk' ? 'POST' : 'DELETE',
							url: `${ingestHost}/ingest/v2`,
							headers: { 'X-Api-Key': sourceKey },
							body: parsed,
							json: true,
						};
					} else {
						const originId = this.getNodeParameter('originId', i) as string;
						const method: IHttpRequestMethods = operation === 'delete' ? 'DELETE' : 'POST';
						options = {
							method,
							url: `${ingestHost}/ingest/v2/${encodeURIComponent(originId)}`,
							headers: { 'X-Api-Key': sourceKey },
							json: true,
						};
						if (operation === 'save') {
							const entityType = this.getNodeParameter('entityType', i) as string;
							const properties = this.getNodeParameter('properties', i) as IDataObject;
							options.headers!['X-Enterspeed-Type'] = entityType;
							options.body =
								typeof properties === 'string' ? JSON.parse(properties as unknown as string) : properties;
						}
					}
				} else if (resource === 'delivery') {
					// The Delivery API expects repeated query params (id=a&id=b),
					// so build the query string explicitly rather than passing an
					// array to `qs` (which serializes as id[0]=a&id[1]=b).
					const url = this.getNodeParameter('url', i) as string;
					const ids = this.getNodeParameter('ids', i) as string;
					const handles = this.getNodeParameter('handles', i) as string;
					const params = new URLSearchParams();
					if (url) params.append('url', url);
					if (ids)
						ids
							.split(',')
							.map((s) => s.trim())
							.filter(Boolean)
							.forEach((v) => params.append('id', v));
					if (handles)
						handles
							.split(',')
							.map((s) => s.trim())
							.filter(Boolean)
							.forEach((v) => params.append('handle', v));
					const query = params.toString();
					options = {
						method: 'GET',
						url: `${deliveryHost}/v2${query ? `?${query}` : ''}`,
						headers: { 'X-Api-Key': envKey },
						json: true,
					};
				} else if (resource === 'query' && operation === 'queryMulti') {
					const specifyQuery = this.getNodeParameter('specifyQuery', i, 'fields') as string;
					let body: IDataObject[];
					if (specifyQuery === 'json') {
						const raw = this.getNodeParameter('queryBody', i) as IDataObject[] | string;
						const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
						if (!Array.isArray(parsed)) {
							throw new NodeOperationError(this.getNode(), 'Queries (JSON) must be a JSON array', { itemIndex: i });
						}
						if (parsed.length > MAX_MULTI_QUERIES) {
							throw new NodeOperationError(
								this.getNode(),
								`A maximum of ${MAX_MULTI_QUERIES} queries are allowed per request`,
								{ itemIndex: i },
							);
						}
						body = parsed;
					} else {
						const queries = this.getNodeParameter('queries.query', i, []) as IDataObject[];
						if (!queries.length) {
							throw new NodeOperationError(this.getNode(), 'At least one query is required', { itemIndex: i });
						}
						if (queries.length > MAX_MULTI_QUERIES) {
							throw new NodeOperationError(
								this.getNode(),
								`A maximum of ${MAX_MULTI_QUERIES} queries are allowed per request`,
								{ itemIndex: i },
							);
						}
						body = queries.map((q) => {
							const queryFields =
								q.specifyQuery === 'json'
									? (() => {
											const raw = q.queryBody as IDataObject | string;
											return typeof raw === 'string' ? JSON.parse(raw) : raw ?? {};
										})()
									: buildQueryPayload(q);
							return { index: q.indexAlias, name: q.name, ...queryFields };
						});
					}
					options = {
						method: 'POST',
						url: `${queryHost}/v1`,
						headers: { 'X-Api-Key': envKey },
						body,
						json: true,
					};
				} else if (resource === 'query') {
					const indexAlias = this.getNodeParameter('indexAlias', i) as string;
					const specifyQuery = this.getNodeParameter('specifyQuery', i, 'json') as string;
					let body: IDataObject;
					if (specifyQuery === 'fields') {
						body = buildQueryPayload({
							filtersCombinator: this.getNodeParameter('filtersCombinator', i, 'and'),
							filtersUi: this.getNodeParameter('filtersUi', i, {}),
							sortUi: this.getNodeParameter('sortUi', i, {}),
							facetsUi: this.getNodeParameter('facetsUi', i, {}),
							queryOptions: this.getNodeParameter('queryOptions', i, {}),
						});
					} else {
						body = this.getNodeParameter('queryBody', i) as IDataObject;
					}
					
					// If the query body is a object with no properties we need to make it into a '{\n}\n' string since the HttpOptions will convert into a empty oject and send it. If it is a empty object then it will sent '${}'
					if (Object.keys(body).length === 0) {
						body = '{\n}\n' as unknown as IDataObject;
					}

					console.log('query body', typeof(body));
					console.log('query body', JSON.stringify(body, null, 2));
					options = {
						method: 'POST',
						url: `${queryHost}/v1/${encodeURIComponent(indexAlias)}`,
						headers: { 'X-Api-Key': envKey },
						body,
						json: true,
					};
				} else {
					// route
					const first = this.getNodeParameter('first', i) as number;
					options = {
						method: 'GET',
						url: `${ingestHost}/routes/v1`,
						qs: { first },
						headers: { 'X-Api-Key': envKey },
						json: true,
					};
				}

				const response = await this.helpers.httpRequest(options);
				if (resource === 'query' && operation === 'queryMulti' && Array.isArray(response)) {
					(response as IDataObject[]).forEach((r) => out.push({ json: r, pairedItem: { item: i } }));
				} else {
					out.push({ json: response as IDataObject, pairedItem: { item: i } });
				}
			} catch (error) {
				const nodeError =
					error instanceof NodeOperationError
						? error
						: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				if (this.continueOnFail()) {
					out.push({
						json: { error: nodeError.message, description: nodeError.description },
						pairedItem: { item: i },
					});
					continue;
				}
				throw nodeError;
			}
		}

		return [out];
	}
}
