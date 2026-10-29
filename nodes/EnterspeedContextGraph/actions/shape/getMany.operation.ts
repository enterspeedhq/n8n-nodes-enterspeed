import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, NodeApiError } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { deliveryError, failedItem, invalidKey, shapesUrl } from './shared';

export const properties: INodeProperties[] = [
	{
		displayName: 'Shape Keys',
		name: 'shapeKeys',
		type: 'json',
		default: '={{ $json.keys }}',
		required: true,
		displayOptions: { show: { resource: ['shape'], operation: ['getMany'] } },
		description:
			'The list of shape keys to read, e.g. built in a Code node. Each key is the shape name, then each ID segment\'s name and value, joined with colons.',
	},
];

/**
 * The Delivery service refuses a batch body over 32 KiB. A request is closed
 * before it would pass this, with headroom; it is the only reason a list of
 * keys is split into several requests.
 */
export const MAX_BODY_BYTES = 30 * 1024;

/** `{"keys":[]}` */
const BODY_OVERHEAD_BYTES = 11;

interface Key {
	itemIndex: number;
	key: string;
	/** The key's share of the body: its JSON string and a separating comma. */
	bytes: number;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Groups keys into requests whose bodies stay under MAX_BODY_BYTES. */
function toRequests<K extends Key>(keys: K[]): K[][] {
	const requests: K[][] = [];
	let current: K[] = [];
	let bytes = BODY_OVERHEAD_BYTES;
	for (const k of keys) {
		if (current.length && bytes + k.bytes > MAX_BODY_BYTES) {
			requests.push(current);
			current = [];
			bytes = BODY_OVERHEAD_BYTES;
		}
		current.push(k);
		bytes += k.bytes;
	}
	if (current.length) requests.push(current);
	return requests;
}

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/**
 * Reads each input item's list of shape keys with one
 * `POST {deliveryUrl}/shapes/v1/{manifest}` (split only at the body limit).
 * The service answers 207 with one `{ key, status, data }` per key, in
 * request order (Shapes batch envelope), which is output as it is, paired to
 * the item the list came from: a key with no shape comes out with status 404
 * and `data: null`, and the rest still return.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const fail = (key: unknown, error: NodeApiError | NodeOperationError) => {
			if (!this.continueOnFail()) throw error;
			return failedItem(key, itemIndex, error);
		};

		const list = parseJson(this.getNodeParameter('shapeKeys', itemIndex, undefined));
		if (!Array.isArray(list)) {
			const message = `Item ${itemIndex} has Shape Keys that are not a list.`;
			results.push(fail(undefined, new NodeOperationError(this.getNode(), message, { itemIndex })));
			continue;
		}

		// One output slot per key, in list order.
		const slots: Array<INodeExecutionData | undefined> = new Array(list.length);
		const keys: Array<Key & { slot: number }> = [];
		list.forEach((key: unknown, slot) => {
			const where = `Item ${itemIndex}, key ${slot}`;
			const problem = invalidKey(key);
			if (problem) {
				slots[slot] = fail(key, new NodeOperationError(this.getNode(), `${where} ${problem}.`, { itemIndex }));
				return;
			}
			const bytes = byteLength(JSON.stringify(key)) + 1;
			if (BODY_OVERHEAD_BYTES + bytes > MAX_BODY_BYTES) {
				const message = `${where} is longer than the Delivery URL accepts.`;
				slots[slot] = fail(key, new NodeOperationError(this.getNode(), message, { itemIndex }));
				return;
			}
			keys.push({ itemIndex, key: key as string, bytes, slot });
		});

		for (const request of toRequests(keys)) {
			let response: unknown;
			try {
				response = await contextGraphApiRequest.call(this, {
					method: 'POST',
					url: shapesUrl(creds),
					body: { keys: request.map((k) => k.key) },
					json: true,
				});
			} catch (error) {
				const nodeError = deliveryError.call(this, error, creds, { itemIndex });
				request.forEach((k) => (slots[k.slot] = fail(k.key, nodeError)));
				continue;
			}

			const answered = parseJson(response);
			if (!Array.isArray(answered) || answered.length !== request.length) {
				const message = `Expected ${request.length} shapes from the Delivery URL but got ${Array.isArray(answered) ? answered.length : 'none'}`;
				const nodeError = new NodeOperationError(this.getNode(), message, { itemIndex });
				request.forEach((k) => (slots[k.slot] = fail(k.key, nodeError)));
				continue;
			}

			request.forEach((k, i) => {
				slots[k.slot] = { json: answered[i] as IDataObject, pairedItem: { item: itemIndex } };
			});
		}

		results.push(...slots.filter((s): s is INodeExecutionData => s !== undefined));
	}

	return results;
}
