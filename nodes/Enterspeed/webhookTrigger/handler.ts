import type { IDataObject, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';

/**
 * Payload (PascalCase, from the enterspeed-destination-webhook connector):
 *   { Id, OriginId, Type, Action: "Deploy" | "Remove", Url? }
 * `Url` (absolute Delivery API URL) is only present when Action is "Deploy".
 * The access key is sent in the `X-Api-Key` header (no HMAC signature).
 */
export async function handleWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
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
