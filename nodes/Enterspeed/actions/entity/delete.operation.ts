import type { IExecuteFunctions, IHttpRequestOptions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';
import { withDeletedFlag } from './shared';

export const properties: INodeProperties[] = [
	{
		displayName: 'Origin ID',
		name: 'originId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['entity'], operation: ['delete'] } },
		description: 'Unique ID of the entity in your source system',
	},
];

export async function execute(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: EnterspeedCredentials,
): Promise<INodeExecutionData[]> {
	if (!creds.sourceKey) {
		throw new NodeOperationError(this.getNode(), 'Source API Key is required for ingest operations', {
			itemIndex,
		});
	}
	const originId = this.getNodeParameter('originId', itemIndex) as string;
	const options: IHttpRequestOptions = {
		method: 'DELETE',
		url: `${creds.ingestHost}/ingest/v2/${encodeURIComponent(originId)}`,
		headers: { 'X-Api-Key': creds.sourceKey },
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: withDeletedFlag(response), pairedItem: { item: itemIndex } }];
}
