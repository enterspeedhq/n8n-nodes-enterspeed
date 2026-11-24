import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import type { ContextGraphCredentials } from '../types';
import { artifactsUrl, ingestGet, readEachItem } from './shared';

const show = { resource: ['artifact'], operation: ['get'] };

/** Source and Artifact ID, shown for the operations that read one artifact. */
export const targetProperties = (operation: string): INodeProperties[] => [
	{
		displayName: 'Source',
		name: 'sourceAlias',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. pim',
		description: 'The alias of the source the artifact was uploaded to',
		displayOptions: { show: { resource: ['artifact'], operation: [operation] } },
	},
	{
		displayName: 'Artifact ID',
		name: 'artifactId',
		type: 'string',
		default: '={{ $json.id }}',
		required: true,
		description: "The artifact's ID, e.g. from Artifact › Upload's or Get Many's output",
		displayOptions: { show: { resource: ['artifact'], operation: [operation] } },
	},
];

export const properties: INodeProperties[] = [
	{
		displayName:
			"Reads an artifact's state and, once committed, its drain result: counts by outcome and the first page of records that didn't land (lines, with nextAfter). Use Get Lines for every such record. The node doesn't wait for the drain: put a Wait node before this one.",
		name: 'getNotice',
		type: 'notice',
		default: '',
		displayOptions: { show },
	},
	...targetProperties('get'),
];

/**
 * Reads one artifact per input item, `GET {ingestUrl}/v1/sources/{alias}/artifacts/{id}`
 * (*Ingest artifact* spec, status), and outputs it as answered, paired to its item.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	return readEachItem.call(this, true, async (itemIndex, { source, id }) => [
		await ingestGet.call(this, `${artifactsUrl(creds, source)}/${encodeURIComponent(id)}`, {}, creds, itemIndex),
	]);
}
