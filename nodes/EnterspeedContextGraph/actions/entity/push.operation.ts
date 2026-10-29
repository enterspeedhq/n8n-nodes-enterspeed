import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import type { ContextGraphCredentials } from '../types';
import type { Line } from './shared';
import { buildLine, failedResult, sendRequests } from './shared';

const show = { resource: ['entity'], operation: ['push'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Entity ID',
		name: 'entityId',
		type: 'string',
		default: '={{ $json.$id }}',
		required: true,
		displayOptions: { show },
		// eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id -- $id is the Ingest NDJSON contract's field name, and field names are case-sensitive
		description:
			"The source system's own key for the record, sent as $id. Must be text. Defaults to the record's own $id.",
	},
	{
		displayName: 'Entity Type',
		name: 'entityType',
		type: 'string',
		default: '={{ $json.$type }}',
		required: true,
		displayOptions: { show },
		description: "The entity type, sent as $type. Must be text. Defaults to the record's own $type.",
	},
	{
		displayName: 'Source',
		name: 'source',
		type: 'string',
		default: '={{ $json.$source }}',
		displayOptions: { show },
		description:
			"The source the record belongs to, sent as $source. When empty, the Context Graph takes the source from the API key (the local dev-server can't, and rejects the record). Defaults to the record's own $source.",
	},
	{
		displayName: 'Action',
		name: 'action',
		type: 'string',
		default: '={{ $json.$action }}',
		displayOptions: { show },
		description:
			"'delete' removes the entity; anything else, or empty, saves the record. A delete sends only the entity's ID, type, source and modified time. Defaults to the record's own $action.",
	},
	{
		displayName: 'Modified At',
		name: 'modifiedAt',
		type: 'string',
		default: '={{ $json.$modifiedAt }}',
		displayOptions: { show },
		description:
			"When the record last changed in the source, as an ISO 8601 time with an offset, sent as $modifiedAt. Writes to an entity are applied in this order, so an older write that arrives late doesn't overwrite a newer one. A record sent without one is applied, but a later upload of the source's export can overwrite it. Defaults to the record's own $modifiedAt.",
	},
];

/**
 * Pushes each input item, as the record it is, to `POST {ingestUrl}/entities`,
 * one request per item. Outputs one result per item, in input order: a record
 * the service rejected, or one without a valid ID or type, comes out with
 * `accepted: false` and the reason instead of stopping the run.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const built = items.map((item, itemIndex) =>
		buildLine(
			`Item ${itemIndex}`,
			itemIndex,
			{
				id: this.getNodeParameter('entityId', itemIndex, undefined),
				type: this.getNodeParameter('entityType', itemIndex, undefined),
				source: this.getNodeParameter('source', itemIndex, undefined),
				action: this.getNodeParameter('action', itemIndex, undefined),
				modifiedAt: this.getNodeParameter('modifiedAt', itemIndex, undefined),
			},
			item.json,
		),
	);

	const lines = built.filter((b): b is Line => !('error' in b));
	const sent = await sendRequests.call(
		this,
		creds.ingestUrl,
		lines.map((l) => [l]),
	);

	return built.map((b) => ('error' in b ? failedResult(b) : (sent.get(b) as INodeExecutionData)));
}
