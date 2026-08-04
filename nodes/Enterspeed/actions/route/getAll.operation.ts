import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';

export const properties: INodeProperties[] = [
	{
		displayName: 'Continuation Token',
		name: 'continuationToken',
		// eslint-disable-next-line n8n-nodes-base/node-param-type-options-password-missing -- pagination cursor, not a secret
		type: 'string',
		default: '',
		displayOptions: { show: { resource: ['route'] } },
		description:
			'Token used to retrieve the next page of results. Leave empty to fetch the first page, then pass the "continuationToken" from the previous response to page through the rest.',
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: EnterspeedCredentials,
): Promise<INodeExecutionData[]> {
	const continuationToken = this.getNodeParameter('continuationToken', itemIndex) as string;
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: `${creds.ingestHost}/routes/v2`,
		headers: {
			'X-Api-Key': creds.envKey,
			...(continuationToken ? { 'X-Continuation-Token': continuationToken } : {}),
		},
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
