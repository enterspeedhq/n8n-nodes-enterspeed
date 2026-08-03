import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';
import { buildQueryFields, buildQueryPayload, withDisplayGuard } from './shared';

export const properties: INodeProperties[] = [
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
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: EnterspeedCredentials,
): Promise<INodeExecutionData[]> {
	const indexAlias = this.getNodeParameter('indexAlias', itemIndex) as string;
	const specifyQuery = this.getNodeParameter('specifyQuery', itemIndex, 'json') as string;
	let body: IDataObject;
	if (specifyQuery === 'fields') {
		body = buildQueryPayload({
			filtersCombinator: this.getNodeParameter('filtersCombinator', itemIndex, 'and'),
			filtersUi: this.getNodeParameter('filtersUi', itemIndex, {}),
			sortUi: this.getNodeParameter('sortUi', itemIndex, {}),
			facetsUi: this.getNodeParameter('facetsUi', itemIndex, {}),
			queryOptions: this.getNodeParameter('queryOptions', itemIndex, {}),
		});
	} else {
		body = this.getNodeParameter('queryBody', itemIndex) as IDataObject;
	}

	// If the query body is a object with no properties we need to make it into a '{\n}\n' string since the HttpOptions will convert into a empty oject and send it. If it is a empty object then it will sent '${}'
	if (Object.keys(body).length === 0) {
		body = '{\n}\n' as unknown as IDataObject;
	}

	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${creds.queryHost}/v1/${encodeURIComponent(indexAlias)}`,
		headers: { 'X-Api-Key': creds.envKey },
		body,
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
