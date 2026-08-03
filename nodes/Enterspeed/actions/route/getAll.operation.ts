import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';

export const properties: INodeProperties[] = [
	{
		displayName: 'Page Size',
		name: 'first',
		type: 'number',
		default: 100,
		typeOptions: { minValue: 100, maxValue: 500 },
		displayOptions: { show: { resource: ['route'] } },
		description: 'Number of routes per page (100–500)',
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: EnterspeedCredentials,
): Promise<INodeExecutionData[]> {
	const first = this.getNodeParameter('first', itemIndex) as number;
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: `${creds.ingestHost}/routes/v1`,
		qs: { first },
		headers: { 'X-Api-Key': creds.envKey },
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
