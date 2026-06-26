import { vi, type Mock } from 'vitest';
import type {
	IExecuteFunctions,
	IPollFunctions,
	IWebhookFunctions,
	IDataObject,
} from 'n8n-workflow';

type ParamMap = Record<string, unknown>;

/**
 * Builds a minimal IExecuteFunctions stand-in for the Enterspeed action node.
 * Parameters are looked up by name (the item index is ignored, which is fine
 * since the tests use a single set of values per case).
 */
export function createExecuteMock(opts: {
	params: ParamMap;
	creds: IDataObject;
	items?: IDataObject[];
	httpRequest: Mock;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const items = (opts.items ?? [{}]).map((json) => ({ json }));
	return {
		getInputData: () => items,
		getCredentials: vi.fn(async () => opts.creds),
		getNodeParameter: (name: string) => opts.params[name],
		getNode: () => ({ name: 'Enterspeed' }),
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: { httpRequest: opts.httpRequest },
	} as unknown as IExecuteFunctions;
}

/**
 * Builds a minimal IPollFunctions stand-in for the trigger. `staticData` is a
 * live object so change-detection state persists across successive poll() calls.
 */
export function createPollMock(opts: {
	params: ParamMap;
	creds: IDataObject;
	httpRequest: Mock;
	staticData?: IDataObject;
}): { ctx: IPollFunctions; staticData: IDataObject } {
	const staticData = opts.staticData ?? {};
	const ctx = {
		getCredentials: vi.fn(async () => opts.creds),
		getNodeParameter: (name: string) => opts.params[name],
		getNode: () => ({ name: 'Enterspeed Trigger' }),
		getWorkflowStaticData: () => staticData,
		helpers: { httpRequest: opts.httpRequest },
	} as unknown as IPollFunctions;
	return { ctx, staticData };
}

/**
 * Builds a minimal IWebhookFunctions stand-in for the webhook trigger.
 * `returnJsonArray` mirrors n8n's helper (wraps each object as { json }).
 * `responseStatus`/`responseBody` capture what the node sent on the rejection
 * path so tests can assert on the 403 without a real HTTP layer.
 */
export function createWebhookMock(opts: {
	params: ParamMap;
	creds: IDataObject;
	body: IDataObject;
	headers?: IDataObject;
	httpRequest: Mock;
}): { ctx: IWebhookFunctions; response: { status?: number; body?: unknown } } {
	const response: { status?: number; body?: unknown } = {};
	const ctx = {
		getCredentials: vi.fn(async () => opts.creds),
		getNodeParameter: (name: string) => opts.params[name],
		getNode: () => ({ name: 'Enterspeed Webhook Trigger' }),
		getBodyData: () => opts.body,
		getHeaderData: () => opts.headers ?? {},
		getResponseObject: () => ({
			status: (code: number) => {
				response.status = code;
				return { send: (b: unknown) => { response.body = b; } };
			},
		}),
		helpers: {
			httpRequest: opts.httpRequest,
			returnJsonArray: (data: IDataObject[]) => data.map((json) => ({ json })),
		},
	} as unknown as IWebhookFunctions;
	return { ctx, response };
}

export const defaultCreds: IDataObject = {
	environmentApiKey: 'env-key',
	sourceApiKey: 'source-key',
	ingestHost: 'https://api.enterspeed.com',
	deliveryHost: 'https://delivery.enterspeed.com',
	queryHost: 'https://query.enterspeed.com',
};
