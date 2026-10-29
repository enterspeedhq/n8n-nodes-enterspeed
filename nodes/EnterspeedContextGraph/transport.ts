import type { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';

/**
 * Thin wrapper shared by every operation. Authenticates with the
 * `enterspeedContextGraphApi` credential, which adds the X-Api-Key header.
 */
export async function contextGraphApiRequest(
	this: IExecuteFunctions,
	options: IHttpRequestOptions,
): Promise<unknown> {
	return this.helpers.httpRequestWithAuthentication.call(this, 'enterspeedContextGraphApi', options);
}

interface HttpError {
	httpCode?: string | null;
	statusCode?: number;
	response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
	cause?: HttpError;
}

/**
 * The status, body and headers of a failed request. n8n hands the failure
 * over wrapped in a NodeApiError, with the HTTP error as its `cause`, so both
 * are looked at. No status means there was no answer at all.
 */
export function httpFailure(error: unknown): {
	status?: number;
	data?: unknown;
	headers?: Record<string, unknown>;
} {
	const e = (error ?? {}) as HttpError;
	const response = e.response ?? e.cause?.response;
	const code = e.httpCode ?? e.cause?.httpCode;
	const status = response?.status ?? e.statusCode ?? (code ? Number(code) : undefined);
	return {
		status: status === undefined || Number.isNaN(status) ? undefined : status,
		data: response?.data,
		headers: response?.headers,
	};
}
