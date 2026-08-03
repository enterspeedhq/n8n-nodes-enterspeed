import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';

export const properties: INodeProperties[] = [
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
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: EnterspeedCredentials,
): Promise<INodeExecutionData[]> {
	// The Delivery API expects repeated query params (id=a&id=b),
	// so build the query string explicitly rather than passing an
	// array to `qs` (which serializes as id[0]=a&id[1]=b).
	const url = this.getNodeParameter('url', itemIndex) as string;
	const ids = this.getNodeParameter('ids', itemIndex) as string;
	const handles = this.getNodeParameter('handles', itemIndex) as string;
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
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: `${creds.deliveryHost}/v2${query ? `?${query}` : ''}`,
		headers: { 'X-Api-Key': creds.envKey },
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
