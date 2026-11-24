import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ContextGraphCredentials } from '../types';
import { artifactsUrl, ingestGet, pagingProperties, readEachItem, readLimit } from './shared';

const show = { resource: ['artifact'], operation: ['getMany'] };

/** The largest page the listing answers (*Ingest artifact* spec, list). */
export const MAX_LIST_LIMIT = 200;

export const properties: INodeProperties[] = [
	{
		displayName: 'Source',
		name: 'sourceAlias',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. pim',
		description: 'The alias of the source whose artifacts to list',
		displayOptions: { show },
	},
	...pagingProperties('getMany', { maxValue: MAX_LIST_LIMIT }),
	{
		displayName: 'State',
		name: 'state',
		type: 'options',
		options: [
			{ name: 'Any', value: '' },
			{ name: 'Committed', value: 'committed' },
			{ name: 'Drained', value: 'drained' },
			{ name: 'Draining', value: 'draining' },
			{ name: 'Expired', value: 'expired' },
			{ name: 'Failed', value: 'failed' },
			{ name: 'Reserved', value: 'reserved' },
			{ name: 'Superseded', value: 'superseded' },
		],
		default: '',
		description: 'Only artifacts in this state',
		displayOptions: { show },
	},
];

/**
 * Lists a source's artifacts per input item, newest reservation first,
 * `GET {ingestUrl}/v1/sources/{alias}/artifacts` (*Ingest artifact* spec, list),
 * and outputs each artifact as answered, paired to the item. Return All
 * follows `nextCursor`, sending the same `state` with each cursor.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	return readEachItem.call(this, false, async (itemIndex, { source }) => {
		const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
		const limit = returnAll ? MAX_LIST_LIMIT : readLimit.call(this, itemIndex, MAX_LIST_LIMIT);
		const state = this.getNodeParameter('state', itemIndex, '') as string;
		const url = artifactsUrl(creds, source);

		const artifacts: IDataObject[] = [];
		let cursor: string | undefined;
		do {
			const page = await ingestGet.call(
				this,
				url,
				{ limit, ...(state && { state }), ...(cursor && { cursor }) },
				creds,
				itemIndex,
			);
			if (!Array.isArray(page.artifacts)) {
				throw new NodeOperationError(this.getNode(), "The Ingest URL didn't answer with a listing of artifacts.", {
					itemIndex,
				});
			}
			artifacts.push(...(page.artifacts as IDataObject[]));
			cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
		} while (returnAll && cursor);
		return artifacts;
	});
}
