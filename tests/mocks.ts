import { vi, type Mock } from 'vitest';
import type {
	IExecuteFunctions,
	IWebhookFunctions,
	IDataObject,
} from 'n8n-workflow';

type ParamMap = Record<string, unknown>;

/**
 * Builds a minimal IExecuteFunctions stand-in for the Enterspeed action node.
 * Parameters are looked up by name (the item index is ignored, which is fine
 * since the tests use a single set of values per case). The optional 3rd
 * `fallback` argument to `getNodeParameter` is honoured, since the node relies
 * on it (e.g. `getNodeParameter('queries.query', i, [])`).
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
		getNodeParameter: (name: string, _i?: number, fallback?: unknown) =>
			name in opts.params ? opts.params[name] : fallback,
		getNode: () => ({ name: 'Enterspeed' }),
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: { httpRequest: opts.httpRequest },
	} as unknown as IExecuteFunctions;
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
			// Mirrors the `enterspeedApi` credential's `authenticate` config
			// (injects the Environment API Key as `X-Api-Key`), since the real
			// n8n runtime applies it before delegating to `httpRequest`.
			httpRequestWithAuthentication: async (_credentialType: string, requestOptions: IDataObject) =>
				opts.httpRequest({
					...requestOptions,
					headers: {
						...(requestOptions.headers as IDataObject | undefined),
						'X-Api-Key': opts.creds.environmentApiKey,
					},
				}),
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
