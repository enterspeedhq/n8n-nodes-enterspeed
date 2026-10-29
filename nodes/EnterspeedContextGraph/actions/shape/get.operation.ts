import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, NodeApiError } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { deliveryError, failedItem, invalidKey, shapeKeyProperty, shapesUrl } from './shared';

export const properties: INodeProperties[] = [shapeKeyProperty];

/**
 * The key as the GET route takes it: its colon-joined parts as path
 * segments, each percent-encoded (delivery joins them back with colons). A
 * segment value may hold `?`, `#`, `%` or a space, but never `:` or `/`, so
 * splitting on the colons is exact (Shape key contract).
 */
export const shapePath = (key: string) => key.split(':').map(encodeURIComponent).join('/');

function asObject(response: unknown): IDataObject | undefined {
	let value = response;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : undefined;
}

/** One item's shape, or the error that stops it. */
async function readShape(
	this: IExecuteFunctions,
	key: unknown,
	itemIndex: number,
	creds: ContextGraphCredentials,
): Promise<IDataObject | NodeApiError | NodeOperationError> {
	const problem = invalidKey(key);
	if (problem) return new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });

	let response: unknown;
	try {
		response = await contextGraphApiRequest.call(this, {
			method: 'GET',
			url: `${shapesUrl(creds)}/${shapePath(key as string)}`,
			json: true,
		});
	} catch (error) {
		// The deployed service answers a missing shape, and one the key may not
		// see, with the same bodiless 404.
		return deliveryError.call(this, error, creds, { itemIndex, notFound: `No shape for key "${key}".` });
	}

	return (
		asObject(response) ??
		new NodeOperationError(this.getNode(), `The Delivery URL didn't answer with a shape for key "${key}".`, {
			itemIndex,
		})
	);
}

/**
 * Reads one shape per input item from `GET {deliveryUrl}/shapes/v1/{manifest}/{key}`
 * and outputs it as it is. A key with no shape fails the item.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const key = this.getNodeParameter('shapeKey', itemIndex, undefined);
		const shape = await readShape.call(this, key, itemIndex, creds);
		if (shape instanceof Error) {
			if (!this.continueOnFail()) throw shape;
			results.push(failedItem(key, itemIndex, shape));
		} else {
			results.push({ json: shape, pairedItem: { item: itemIndex } });
		}
	}

	return results;
}
