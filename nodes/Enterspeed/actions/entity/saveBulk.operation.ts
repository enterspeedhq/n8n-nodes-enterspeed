import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { enterspeedApiRequest } from '../../transport';
import type { EnterspeedCredentials } from '../types';
import { MAX_BULK_ENTITIES } from './shared';

export const properties: INodeProperties[] = [
	{
		displayName: 'Entities (JSON Array)',
		name: 'entities',
		type: 'json',
		default: '',
		required: true,
		hint: 'See https://docs.enterspeed.com/api-reference/ingest/save-entities for entities format.',
		displayOptions: { show: { resource: ['entity'], operation: ['saveBulk'] } },
		description: `Array of entities, with up to ${MAX_BULK_ENTITIES} entities. Example: [ { "type": "product", "originId": "p-5427", "properties": { "name": "Official Enterspeed T-shirt" } } ].`,
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
	const raw = this.getNodeParameter('entities', itemIndex) as IDataObject | IDataObject[] | string;
	const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!Array.isArray(parsed)) {
		throw new NodeOperationError(this.getNode(), 'entities must be a JSON array', { itemIndex });
	}
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${creds.ingestHost}/ingest/v2`,
		headers: { 'X-Api-Key': creds.sourceKey },
		body: parsed,
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
