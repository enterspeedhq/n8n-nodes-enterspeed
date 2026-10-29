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
