import type {
	IWebhookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
	IDataObject,
} from 'n8n-workflow';

/**
 * Enterspeed Webhook Trigger (push).
 *
 * Enterspeed pushes outbound webhooks for *views* (a view being deployed or
 * removed). Routes and indices do not emit webhooks, so for those use the
 * polling Enterspeed Trigger instead.
 *
 * Registration is manual: create a webhook in Enterspeed pointing at this
 * node's production URL and (optionally) set an access key. Enterspeed POSTs a
 * lightweight notification — the full view is fetched on demand via the
 * Delivery URL carried in the payload.
 *
 * Payload (PascalCase, from the enterspeed-destination-webhook connector):
 *   { Id, OriginId, Type, Action: "Deploy" | "Remove", Url? }
 * `Url` (absolute Delivery API URL) is only present when Action is "Deploy".
 * The access key is sent in the `X-Api-Key` header (no HMAC signature).
 */
export class EnterspeedWebhookTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed Webhook Trigger',
		name: 'enterspeedWebhookTrigger',
		icon: 'file:enterspeed.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{"Views: " + $parameter["actions"].join(", ")}}',
		description: 'Starts a workflow when an Enterspeed view is deployed or removed',
		defaults: { name: 'Enterspeed Webhook Trigger' },
		inputs: [],
		outputs: ['main'],
		credentials: [{ name: 'enterspeedApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Actions',
				name: 'actions',
				type: 'multiOptions',
				options: [
					{ name: 'Deploy (Published / Updated)', value: 'Deploy' },
					{ name: 'Remove (Deleted)', value: 'Remove' },
				],
				default: ['Deploy', 'Remove'],
				description: 'Which view actions should start the workflow',
			},
			{
				displayName: 'Fetch Full View',
				name: 'fetchView',
				type: 'boolean',
				default: true,
				description:
					'Whether to fetch the full view from the Delivery API (using the environment key) when the payload carries a delivery URL. Only deploys carry a URL.',
			},
			{
				displayName: 'Access Key',
				name: 'accessKey',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'Optional shared secret. If set, the incoming X-Api-Key header must match this value or the request is rejected with 403. Set the same value when configuring the webhook in Enterspeed.',
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const accessKey = this.getNodeParameter('accessKey') as string;
		const actions = this.getNodeParameter('actions') as string[];
		const fetchView = this.getNodeParameter('fetchView') as boolean;

		// Verify the shared secret, if configured. Header names are lower-cased.
		if (accessKey) {
			const headers = this.getHeaderData() as IDataObject;
			if (headers['x-api-key'] !== accessKey) {
				const res = this.getResponseObject();
				res.status(403).send('Invalid access key');
				return { noWebhookResponse: true };
			}
		}

		// Enterspeed sends PascalCase fields (Id, OriginId, Type, Action, Url);
		// fall back to lower-case in case the contract ever changes.
		const body = this.getBodyData() as IDataObject;
		const action = (body.Action ?? body.action) as string | undefined;
		const deliveryUrl = (body.Url ?? body.url) as string | undefined;

		// Acknowledge but don't start the workflow for unselected actions.
		if (action && !actions.includes(action)) {
			return {};
		}

		const payload: IDataObject = { ...body };

		if (fetchView && typeof deliveryUrl === 'string' && deliveryUrl) {
			const creds = await this.getCredentials('enterspeedApi');
			const envKey = creds.environmentApiKey as string;
			try {
				payload.view = await this.helpers.httpRequest({
					method: 'GET',
					url: deliveryUrl,
					headers: { 'X-Api-Key': envKey },
					json: true,
				});
			} catch (error) {
				// A webhook must acknowledge; surface the fetch failure on the item.
				payload.error = (error as Error).message;
			}
		}

		return { workflowData: [this.helpers.returnJsonArray([payload])] };
	}
}
