import { describe, it, expect, vi } from 'vitest';
import type { IDataObject, IWebhookResponseData } from 'n8n-workflow';
import { EnterspeedWebhookTrigger } from '../nodes/Enterspeed/EnterspeedWebhookTrigger.node';
import { createWebhookMock, defaultCreds } from './mocks';

/**
 * The webhook trigger receives Enterspeed's notification payload (PascalCase
 * { Id, OriginId, Type, Action, Url }), optionally verifies the X-Api-Key
 * header, optionally fetches the full view via the delivery URL, and emits it.
 */

const node = new EnterspeedWebhookTrigger();
const baseParams = {
	actions: ['Deploy', 'Remove'],
	fetchView: true,
	accessKey: '',
};

const deployBody: IDataObject = {
	Id: 'view-1',
	OriginId: 'product-1',
	Type: 'productView',
	Action: 'Deploy',
	Url: 'https://delivery.enterspeed.com/v2?id=view-1',
};

function run(opts: {
	body: IDataObject;
	params?: Record<string, unknown>;
	headers?: IDataObject;
	httpRequest?: ReturnType<typeof vi.fn>;
}) {
	const httpRequest = opts.httpRequest ?? vi.fn(async () => ({ id: 'view-1', value: 'full' }));
	const { ctx, response } = createWebhookMock({
		params: { ...baseParams, ...opts.params },
		creds: defaultCreds,
		body: opts.body,
		headers: opts.headers,
		httpRequest,
	});
	return { promise: node.webhook.call(ctx) as Promise<IWebhookResponseData>, httpRequest, response };
}

describe('EnterspeedWebhookTrigger.webhook', () => {
	it('emits the raw notification and makes no HTTP call when fetchView=false', async () => {
		const { promise, httpRequest } = run({ body: deployBody, params: { fetchView: false } });
		const result = await promise;
		expect(httpRequest).not.toHaveBeenCalled();
		expect(result.workflowData?.[0][0].json).toEqual(deployBody);
	});

	it('fetches the full view from the delivery URL with the env key on Deploy', async () => {
		const { promise, httpRequest } = run({ body: deployBody });
		const result = await promise;
		expect(httpRequest).toHaveBeenCalledWith({
			method: 'GET',
			url: deployBody.Url,
			headers: { 'X-Api-Key': 'env-key' },
			json: true,
		});
		expect(result.workflowData?.[0][0].json).toMatchObject({
			Id: 'view-1',
			view: { id: 'view-1', value: 'full' },
		});
	});

	it('does not fetch on Remove (no Url) and emits the notification', async () => {
		const removeBody: IDataObject = { Id: 'view-1', Type: 'productView', Action: 'Remove' };
		const { promise, httpRequest } = run({ body: removeBody });
		const result = await promise;
		expect(httpRequest).not.toHaveBeenCalled();
		expect(result.workflowData?.[0][0].json).toEqual(removeBody);
	});

	it('also honours lower-case payload fields as a fallback', async () => {
		const lowerBody: IDataObject = { id: 'view-1', action: 'Deploy', url: 'https://delivery.enterspeed.com/v2?id=view-1' };
		const { promise, httpRequest } = run({ body: lowerBody });
		await promise;
		expect(httpRequest).toHaveBeenCalledWith(
			expect.objectContaining({ url: lowerBody.url }),
		);
	});

	it('acknowledges but does not start the workflow for an unselected action', async () => {
		const { promise, httpRequest } = run({ body: deployBody, params: { actions: ['Remove'] } });
		const result = await promise;
		expect(result).toEqual({});
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('rejects with 403 when the access key header does not match', async () => {
		const { promise, httpRequest, response } = run({
			body: deployBody,
			params: { accessKey: 'secret' },
			headers: { 'x-api-key': 'wrong' },
		});
		const result = await promise;
		expect(response.status).toBe(403);
		expect(result.noWebhookResponse).toBe(true);
		expect(result.workflowData).toBeUndefined();
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('passes when the access key header matches', async () => {
		const { promise } = run({
			body: deployBody,
			params: { accessKey: 'secret' },
			headers: { 'x-api-key': 'secret' },
		});
		const result = await promise;
		expect(result.workflowData?.[0][0].json).toMatchObject({ Id: 'view-1' });
	});

	it('still emits with an error field when the view fetch fails', async () => {
		const httpRequest = vi.fn(async () => {
			throw new Error('boom');
		});
		const { promise } = run({ body: deployBody, httpRequest });
		const result = await promise;
		expect(result.workflowData?.[0][0].json).toMatchObject({ Id: 'view-1', error: 'boom' });
	});
});
