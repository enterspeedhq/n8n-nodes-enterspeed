import type { INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { properties } from './webhookTrigger/properties';
import { handleWebhook } from './webhookTrigger/handler';

/**
 * Enterspeed Trigger (webhook / push).
 *
 * Enterspeed pushes outbound webhooks for *views* (a view being deployed or
 * removed).
 *
 * Registration is manual: create a webhook in Enterspeed pointing at this
 * node's production URL and (optionally) set an access key. Enterspeed POSTs a
 * lightweight notification — the full view is fetched on demand via the
 * Delivery URL carried in the payload.
 *
 * name convention enterspeedTrigger for putting it under the Enterspeed node
 * instead of having a separate node called Enterspeed Webhook Trigger.
 * Properties + webhook handling live under ./webhookTrigger; this file just
 * wires them into the INodeType class.
 */
export class EnterspeedTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed Webhook Trigger',
		name: 'enterspeedTrigger',
		icon: 'file:enterspeed.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{"Views: " + $parameter["actions"].join(", ")}}',
		description: 'Starts a workflow when an Enterspeed view is deployed or removed',
		defaults: { name: 'Enterspeed Webhook Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'enterspeedApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties,
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return handleWebhook.call(this);
	}
}
