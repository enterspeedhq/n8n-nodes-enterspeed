import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';
import { MAX_BULK_ENTITIES } from './shared';

export const properties: INodeProperties[] = [
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
	const raw = this.getNodeParameter('originIds', itemIndex) as IDataObject | string;
	const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		Array.isArray(parsed) ||
		!Array.isArray((parsed as IDataObject).originIds)
	) {
		throw new NodeOperationError(
			this.getNode(),
			'originIds must be a JSON object in the form { "originIds": [...] }',
			{ itemIndex },
		);
	}
	const options: IHttpRequestOptions = {
		method: 'DELETE',
		url: `${creds.ingestHost}/ingest/v2`,
		headers: { 'X-Api-Key': creds.sourceKey },
		body: parsed,
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
