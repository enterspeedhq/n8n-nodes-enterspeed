import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';
import { MAX_MULTI_QUERIES, buildQueryFields, buildQueryPayload } from './shared';

export const properties: INodeProperties[] = [
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
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: EnterspeedCredentials,
): Promise<INodeExecutionData[]> {
	const specifyQuery = this.getNodeParameter('specifyQuery', itemIndex, 'fields') as string;
	let body: IDataObject[];
	if (specifyQuery === 'json') {
		const raw = this.getNodeParameter('queryBody', itemIndex) as IDataObject[] | string;
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!Array.isArray(parsed)) {
			throw new NodeOperationError(this.getNode(), 'Queries (JSON) must be a JSON array', { itemIndex });
		}
		if (parsed.length > MAX_MULTI_QUERIES) {
			throw new NodeOperationError(
				this.getNode(),
				`A maximum of ${MAX_MULTI_QUERIES} queries are allowed per request`,
				{ itemIndex },
			);
		}
		body = parsed;
	} else {
		const queries = this.getNodeParameter('queries.query', itemIndex, []) as IDataObject[];
		if (!queries.length) {
			throw new NodeOperationError(this.getNode(), 'At least one query is required', { itemIndex });
		}
		if (queries.length > MAX_MULTI_QUERIES) {
			throw new NodeOperationError(
				this.getNode(),
				`A maximum of ${MAX_MULTI_QUERIES} queries are allowed per request`,
				{ itemIndex },
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

	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${creds.queryHost}/v1`,
		headers: { 'X-Api-Key': creds.envKey },
		body,
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	if (Array.isArray(response)) {
		return (response as IDataObject[]).map((r) => ({ json: r, pairedItem: { item: itemIndex } }));
	}
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
