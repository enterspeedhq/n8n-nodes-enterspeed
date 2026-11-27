import type { IDataObject, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { headerValueMatches, verifySignature } from './signature';

/**
 * Receives one outbound envelope delivery (semantic-graph
 * `contracts/spec/outbound-envelope.md`):
 *
 *   { type, environmentId, deliveryId, tags: [{ key, hash, action }] }
 *
 * signed with Standard Webhooks headers over the exact body bytes. The
 * signature is checked over n8n's `rawBody`, never a re-serialised body. A
 * delivery that doesn't verify is answered 401 and starts nothing. A verified
 * one starts one run with one item per changed entry; the node is
 * `responseMode: 'onReceived'`, so the sender gets its 2xx straight away.
 * Unknown event types and unknown properties are accepted.
 */
export async function handleWebhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	const credentials = await this.getCredentials('enterspeedContextGraphWebhookApi');
	const headers = this.getHeaderData() as IDataObject;
	const header = (name: string): string | undefined => {
		const value = headers[name.toLowerCase()];
		return typeof value === 'string' ? value : undefined;
	};

	const receiverHeaderName = String(credentials.receiverHeaderName ?? '').trim();
	if (receiverHeaderName !== '') {
		const expected = String(credentials.receiverHeaderSecret ?? '');
		const received = header(receiverHeaderName);
		if (expected === '' || received === undefined || !headerValueMatches(received, expected)) {
			return reject.call(this, 401, 'Missing or wrong receiver header');
		}
	}

	const request = this.getRequestObject();
	if (request.rawBody === undefined && typeof request.readRawBody === 'function') {
		await request.readRawBody();
	}
	const rawBody = request.rawBody as Buffer | undefined;
	if (!rawBody) return reject.call(this, 401, 'No request body to verify');

	const failure = verifySignature(
		String(credentials.signingSecret ?? ''),
		{
			id: header('webhook-id'),
			timestamp: header('webhook-timestamp'),
			signature: header('webhook-signature'),
		},
		rawBody,
		Math.floor(Date.now() / 1000),
	);
	if (failure) return reject.call(this, 401, `Webhook signature rejected (${failure})`);

	let envelope: IDataObject;
	try {
		envelope = JSON.parse(rawBody.toString('utf-8')) as IDataObject;
	} catch {
		return reject.call(this, 400, 'The body is not JSON');
	}
	if (envelope === null || typeof envelope !== 'object' || !Array.isArray(envelope.tags)) {
		return reject.call(this, 400, 'The body is not an outbound envelope');
	}

	const eventTypes = this.getNodeParameter('eventTypes', []) as string[];
	if (eventTypes.length > 0 && !eventTypes.includes(envelope.type as string)) {
		return {};
	}

	// Each entry as it came, plus every envelope field but `tags` (so `type`,
	// `environmentId`, `deliveryId` and any added later); the envelope's win.
	const { tags, ...envelopeFields } = envelope;
	const items = (tags as IDataObject[]).map((tag) => ({ ...tag, ...envelopeFields }));
	if (items.length === 0) return {};

	return { workflowData: [this.helpers.returnJsonArray(items)] };
}

function reject(this: IWebhookFunctions, status: number, message: string): IWebhookResponseData {
	this.getResponseObject().status(status).send(message);
	return { noWebhookResponse: true };
}
