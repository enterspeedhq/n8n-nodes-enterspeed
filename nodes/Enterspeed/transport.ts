import type { IDataObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';

/** Thin wrapper around `this.helpers.httpRequest` shared by every operation. */
export async function enterspeedApiRequest(
	this: IExecuteFunctions,
	options: IHttpRequestOptions,
): Promise<IDataObject | IDataObject[]> {
	return this.helpers.httpRequest(options) as Promise<IDataObject | IDataObject[]>;
}
