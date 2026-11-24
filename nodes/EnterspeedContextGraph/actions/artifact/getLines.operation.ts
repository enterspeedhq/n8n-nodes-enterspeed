import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ContextGraphCredentials } from '../types';
import { targetProperties } from './get.operation';
import { artifactsUrl, ingestGet, pagingProperties, readEachItem, readLimit } from './shared';

export const properties: INodeProperties[] = [
	{
		displayName:
			"Outputs each record of the artifact that was refused, failed or didn't parse, one item each: its record number, outcome, entity type and ID when it named them, and the reason. A record that landed isn't listed.",
		name: 'getLinesNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { resource: ['artifact'], operation: ['getLines'] } },
	},
	...targetProperties('getLines'),
	...pagingProperties('getLines', {}),
];

/**
 * Pages one artifact's `lines` per input item through its status route,
 * `GET {ingestUrl}/v1/sources/{alias}/artifacts/{id}?after={number}` (*Ingest
 * artifact* spec, the artifact), and outputs each line as answered, paired to
 * the item. Return All follows `nextAfter` until it is `null`; otherwise the
 * pages are read until Limit lines are out. The page size is the platform's.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	return readEachItem.call(this, true, async (itemIndex, { source, id }) => {
		const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
		const limit = returnAll ? Infinity : readLimit.call(this, itemIndex);
		const url = `${artifactsUrl(creds, source)}/${encodeURIComponent(id)}`;

		const lines: IDataObject[] = [];
		let after: number | undefined;
		do {
			const artifact = await ingestGet.call(this, url, after === undefined ? {} : { after }, creds, itemIndex);
			// An artifact not committed yet has no lines.
			if (artifact.lines === undefined || artifact.lines === null) break;
			if (!Array.isArray(artifact.lines)) {
				throw new NodeOperationError(this.getNode(), "The Ingest URL answered the artifact's lines as something other than a list.", {
					itemIndex,
				});
			}
			lines.push(...(artifact.lines as IDataObject[]));
			after = typeof artifact.nextAfter === 'number' ? artifact.nextAfter : undefined;
		} while (after !== undefined && lines.length < limit);
		return lines.slice(0, limit);
	});
}
