import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	IHttpRequestMethods,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

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
				],
				default: 'save',
			},
			{
				displayName: 'Origin ID',
				name: 'originId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['entity'] } },
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
				default: '{}',
				displayOptions: { show: { resource: ['entity'], operation: ['save'] } },
				description: 'The source entity body sent to Enterspeed',
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
					{ name: 'Query Index', value: 'query', action: 'Query items in an index' },
				],
				default: 'query',
			},
			{
				displayName: 'Index Alias',
				name: 'indexAlias',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['query'] } },
				description: 'Alias of the index to query, e.g. productIndex',
			},
			{
				displayName: 'Query Body (JSON)',
				name: 'queryBody',
				type: 'json',
				default: '{\n  "pagination": { "page": 1, "size": 50 }\n}',
				displayOptions: { show: { resource: ['query'] } },
				description: 'Filters, sort, pagination and facets. All properties optional.',
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
				} else if (resource === 'query') {
					const indexAlias = this.getNodeParameter('indexAlias', i) as string;
					const queryBody = this.getNodeParameter('queryBody', i) as IDataObject;
					options = {
						method: 'POST',
						url: `${queryHost}/v1/${encodeURIComponent(indexAlias)}`,
						headers: { 'X-Api-Key': envKey },
						body: typeof queryBody === 'string' ? JSON.parse(queryBody as unknown as string) : queryBody,
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
				out.push({ json: response as IDataObject, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error;
			}
		}

		return [out];
	}
}
