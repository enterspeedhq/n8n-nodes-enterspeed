import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { ContextGraphCredentials } from '../types';
import type { Line, Rejected } from './shared';
import { buildLine, failedResult, sendRequests, toRequests } from './shared';

export const properties: INodeProperties[] = [
	{
		displayName: 'Records',
		name: 'records',
		type: 'json',
		default: '={{ $json.data }}',
		required: true,
		displayOptions: { show: { resource: ['entity'], operation: ['pushMany'] } },
		// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id -- $id is the Ingest NDJSON contract's field name, and field names are case-sensitive
		description:
			'The list of records to push, e.g. the data field from an Aggregate node. Each record is sent as it is and needs its own $id and $type; a record without them is reported as failed.',
	},
];

const isRecord = (value: unknown): value is IDataObject =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** The item's list of records, parsed if it was typed in as JSON text. */
function recordList(value: unknown): unknown[] | undefined {
	let list = value;
	if (typeof list === 'string') {
		try {
			list = JSON.parse(list);
		} catch {
			return undefined;
		}
	}
	return Array.isArray(list) ? list : undefined;
}

/**
 * Pushes each input item's list of records to `POST {ingestUrl}/entities` in
 * one request, split only at the request size limit. Each record keeps its
 * own $ fields (Ingest NDJSON contract). Outputs one result per record, in
 * list order, paired to the item the list came from.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const list = recordList(this.getNodeParameter('records', itemIndex, undefined));
		if (!list) {
			const message = `Item ${itemIndex} has Records that are not a list.`;
			if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), message, { itemIndex });
			results.push({ json: { accepted: false, error: message }, pairedItem: { item: itemIndex } });
			continue;
		}

		const built: Array<Line | Rejected> = list.map((record, r) => {
			const where = `Item ${itemIndex}, record ${r}`;
			if (!isRecord(record)) {
				return { itemIndex, id: undefined, type: undefined, action: 'upsert', error: `${where} is not an object.` };
			}
			const fields = {
				id: record.$id,
				type: record.$type,
				source: record.$source,
				action: record.$action,
				modifiedAt: record.$modifiedAt,
			};
			return buildLine(where, itemIndex, fields, record);
		});

		const lines = built.filter((b): b is Line => !('error' in b));
		const sent = await sendRequests.call(this, creds.ingestUrl, toRequests(lines));
		for (const b of built) results.push('error' in b ? failedResult(b) : (sent.get(b) as INodeExecutionData));
	}

	return results;
}
