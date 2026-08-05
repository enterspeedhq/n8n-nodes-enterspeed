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

export const properties: INodeProperties[] = [
	{
		displayName: 'Origin ID',
		name: 'originId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['entity'], operation: ['save'] } },
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
	const entityType = this.getNodeParameter('entityType', itemIndex) as string;
	const properties = this.getNodeParameter('properties', itemIndex) as IDataObject;
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${creds.ingestHost}/ingest/v2/${encodeURIComponent(originId)}`,
		headers: { 'X-Api-Key': creds.sourceKey, 'X-Enterspeed-Type': entityType },
		body: typeof properties === 'string' ? JSON.parse(properties as unknown as string) : properties,
		json: true,
	};

	const response = await enterspeedApiRequest.call(this, options);
	return [{ json: response as IDataObject, pairedItem: { item: itemIndex } }];
}
