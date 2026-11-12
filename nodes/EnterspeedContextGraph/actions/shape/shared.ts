import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';

/**
 * The Delivery API version the shapes routes are addressed with. A version
 * the service no longer serves answers 410.
 */
export const API_VERSION = 'v1';

/** Get's key, one per item, in the canonical form. */
export const shapeKeyProperty: INodeProperties = {
	displayName: 'Shape Key',
	name: 'shapeKey',
	type: 'string',
	default: '',
	required: true,
	placeholder: 'e.g. productVariant:productId:42:sku:SKU-9',
	displayOptions: { show: { resource: ['shape'], operation: ['get'] } },
	description:
		"The shape's key: the shape name, then each ID segment's name and value, joined with colons. The values are the record's own data (e.g. its ID), not its $-prefixed ID.",
};

/** `{deliveryUrl}/shapes/v1/{manifest}`, the control-plane root (delivery/ADR-030 §3). */
export const shapesUrl = (creds: ContextGraphCredentials) =>
	`${creds.deliveryUrl}/shapes/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}`;

/**
 * Why a key can't be sent, or undefined if it can. Only a missing, blank or
 * non-text key is caught here; everything else about the key is the
 * service's to judge. The key is never trimmed or converted.
 */
export function invalidKey(key: unknown): string | undefined {
	if (key === undefined || key === null || (typeof key === 'string' && !key.trim())) return 'has no Shape Key';
	if (typeof key !== 'string') return 'has a Shape Key that is not text';
	return undefined;
}

/**
 * The text of the service's own error body: `{ message }` from the
 * dev-server, a bare JSON string from the deployed Delivery service.
 */
function platformMessage(data: unknown): string | undefined {
	if (typeof data === 'string') {
		try {
			return platformMessage(JSON.parse(data)) ?? (data.trim() || undefined);
		} catch {
			return data.trim() || undefined;
		}
	}
	const message = (data as IDataObject | undefined)?.message;
	return typeof message === 'string' && message ? message : undefined;
}

/**
 * Turns a failed shapes request into a node error. The service's own message
 * is used where it gives one (a malformed key, an unknown manifest);
 * `notFound` words a 404 without a body. The API key is never included.
 */
export function deliveryError(
	this: IExecuteFunctions,
	error: unknown,
	creds: ContextGraphCredentials,
	opts: { itemIndex?: number; notFound?: string } = {},
): NodeApiError | NodeOperationError {
	const { status, data } = httpFailure(error);
	// No status means no answer at all.
	if (status === undefined) {
		return new NodeOperationError(this.getNode(), `Couldn't reach the Delivery URL (${creds.deliveryUrl}).`, {
			description: (error as Error).message,
			itemIndex: opts.itemIndex,
		});
	}
	const fromService = platformMessage(data);
	let message: string;
	if (status === 401) message = 'The API key was rejected by the Delivery URL.';
	else if (status === 410) message = `The Delivery URL no longer serves API version ${API_VERSION}.`;
	else if (fromService) message = fromService;
	else if (status === 404 && opts.notFound) message = opts.notFound;
	else message = `The Delivery URL answered with status ${status}.`;

	const httpCode = String(status);
	// A plain object, not the request's own error: NodeApiError hands back an
	// existing NodeApiError unchanged, which would drop this message.
	return new NodeApiError(
		this.getNode(),
		{ httpCode },
		{
			message,
			description: fromService && fromService !== message ? fromService : undefined,
			httpCode,
			itemIndex: opts.itemIndex,
		},
	);
}

/** The error item an item gets with Continue On Fail. */
export function failedItem(key: unknown, itemIndex: number, error: NodeApiError | NodeOperationError): INodeExecutionData {
	return {
		json: {
			key: key as IDataObject[string],
			error: error.message,
			...(error.description && { description: error.description }),
		},
		pairedItem: { item: itemIndex },
	};
}
