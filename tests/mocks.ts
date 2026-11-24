import { vi, type Mock } from 'vitest';
import type {
	IExecuteFunctions,
	IWebhookFunctions,
	IDataObject,
	ICredentialDataDecryptedObject,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { EnterspeedContextGraphApi } from '../credentials/EnterspeedContextGraphApi.credentials';
import { httpFailure } from '../nodes/EnterspeedContextGraph/transport';

/** The Context Graph credential's own `authenticate`, run by the Context Graph mock. */
const authenticate = new EnterspeedContextGraphApi().authenticate as (
	credentials: ICredentialDataDecryptedObject,
	requestOptions: IHttpRequestOptions,
) => Promise<IHttpRequestOptions>;

type ParamMap = Record<string, unknown>;

/**
 * n8n's request helper with `ignoreHttpStatusErrors` and `returnFullResponse`,
 * as contextGraphApiRequest sends every request: a test's mock answers with a
 * body (or a full response) or throws a failure with a status, as a server
 * would, and this hands the node the full response either way. A failure with
 * no status (no answer at all) is still thrown, as n8n throws it.
 */
export async function asN8nFullResponse(
	requestOptions: IHttpRequestOptions,
	send: (requestOptions: IHttpRequestOptions) => Promise<unknown>,
): Promise<unknown> {
	const { ignoreHttpStatusErrors, ...sent } = requestOptions;
	if (!ignoreHttpStatusErrors) return send(sent);
	try {
		const answer = (await send(sent)) as { statusCode?: unknown; headers?: unknown } | undefined;
		const isFull = typeof answer?.statusCode === 'number' && answer.headers !== undefined;
		return isFull ? answer : { statusCode: 200, headers: {}, body: answer };
	} catch (error) {
		const { status, data, headers } = httpFailure(error);
		// No answer at all: n8n throws, as before.
		if (status === undefined) return Promise.reject(error);
		return { statusCode: status, headers: headers ?? {}, body: data };
	}
}

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

/**
 * Builds a minimal IExecuteFunctions stand-in for the Context Graph node.
 * A parameter may be a function of the item index, for per-item expressions
 * (e.g. `delete: (i) => i === 1`). `httpRequestWithAuthentication` mirrors the
 * `enterspeedContextGraphApi` credential by running its own `authenticate`
 * (the Ingest or Delivery API Key as `X-Api-Key`), as the real n8n runtime does.
 */
export function createContextGraphExecuteMock(opts: {
	params: Record<string, unknown | ((itemIndex: number) => unknown)>;
	items?: IDataObject[];
	/** Each item's binary data, by field name, as the bytes n8n would hand over. */
	binaries?: Array<Record<string, Buffer> | undefined>;
	creds?: IDataObject;
	httpRequest: Mock;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const creds = opts.creds ?? defaultContextGraphCreds;
	const items = (opts.items ?? [{}]).map((json, i) => {
		const files = opts.binaries?.[i];
		if (!files) return { json };
		const binary = Object.fromEntries(
			Object.entries(files).map(([name, bytes]) => [
				name,
				{ data: bytes.toString('base64'), mimeType: 'application/octet-stream', fileName: name },
			]),
		);
		return { json, binary };
	});
	return {
		getInputData: () => items,
		getCredentials: vi.fn(async () => creds),
		getNodeParameter: (name: string, i: number, fallback?: unknown) => {
			if (!(name in opts.params)) return fallback;
			const value = opts.params[name];
			return typeof value === 'function' ? (value as (i: number) => unknown)(i) : value;
		},
		getNode: () => ({ name: 'Enterspeed Context Graph' }),
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialType: string, requestOptions: IHttpRequestOptions) =>
				asN8nFullResponse(await authenticate(creds, requestOptions), opts.httpRequest),
			// A request without the credential (the signed upload URL), sent as given.
			httpRequest: async (requestOptions: IHttpRequestOptions) => opts.httpRequest(requestOptions),
			getBinaryDataBuffer: async (itemIndex: number, name: string) => {
				const bytes = opts.binaries?.[itemIndex]?.[name];
				if (!bytes) throw new Error(`No binary data "${name}" on item ${itemIndex}`);
				return bytes;
			},
		},
	} as unknown as IExecuteFunctions;
}

export const defaultContextGraphCreds: IDataObject = {
	ingestUrl: 'http://localhost:5090/',
	ingestApiKey: 'cg-ingest-key',
	deliveryUrl: 'http://localhost:5200',
	deliveryApiKey: 'cg-key',
	manifestVersion: '1.0.0',
};
