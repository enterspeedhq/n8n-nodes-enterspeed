import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, NodeApiError } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { API_VERSION, deliveryError } from '../shape/shared';

export const properties: INodeProperties[] = [
	{
		displayName: 'Route',
		name: 'route',
		type: 'string',
		default: '={{ $json.route }}',
		required: true,
		placeholder: 'e.g. /products/42',
		displayOptions: { show: { resource: ['representation'], operation: ['get'] } },
		description: "The representation's route path, starting with a slash, as the schema declares it",
	},
];

/**
 * Why a route can't be sent, or undefined if it can. Only a missing, blank,
 * non-text or relative route is caught here; whether it matches a
 * representation is the service's to judge. The route is never trimmed.
 */
export function invalidRoute(route: unknown): string | undefined {
	if (route === undefined || route === null || (typeof route === 'string' && !route.trim())) return 'has no Route';
	if (typeof route !== 'string') return 'has a Route that is not text';
	if (!route.startsWith('/')) return `has a Route that doesn't start with "/" ("${route}")`;
	return undefined;
}

/**
 * `{deliveryUrl}/v1/{manifest}{route}`, the data plane (delivery/ADR-030 §3).
 * Each segment is percent-encoded and the slashes kept, so a value with URL
 * characters reaches the service as written.
 */
export const representationUrl = (creds: ContextGraphCredentials, route: string) =>
	`${creds.deliveryUrl}/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}${route
		.split('/')
		.map(encodeURIComponent)
		.join('/')}`;

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

/** One item's representation, or the error that stops it. */
async function readRepresentation(
	this: IExecuteFunctions,
	route: unknown,
	itemIndex: number,
	creds: ContextGraphCredentials,
): Promise<IDataObject | NodeApiError | NodeOperationError> {
	const problem = invalidRoute(route);
	if (problem) return new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });

	let response: unknown;
	try {
		// 200, 202 and 207 all carry the body; which slots resolved is in
		// $metadata.<slot>.$state, not the status (Representation envelope).
		response = await contextGraphApiRequest.call(this, {
			method: 'GET',
			url: representationUrl(creds, route as string),
			json: true,
		});
	} catch (error) {
		// A 404 is an unknown route, an unresolved required slot, or no slot
		// resolved at all.
		return deliveryError.call(this, error, creds, { itemIndex, notFound: `No representation for route "${route}".` });
	}

	return (
		asObject(response) ??
		new NodeOperationError(this.getNode(), `The Delivery URL didn't answer with a representation for route "${route}".`, {
			itemIndex,
		})
	);
}

/**
 * Reads one representation per input item from
 * `GET {deliveryUrl}/v1/{manifest}{route}` and outputs it as it is: each slot
 * at its name, plus `$metadata`. A route with no representation fails the item.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const route = this.getNodeParameter('route', itemIndex, undefined);
		const representation = await readRepresentation.call(this, route, itemIndex, creds);
		if (representation instanceof Error) {
			if (!this.continueOnFail()) throw representation;
			results.push({
				json: {
					route: route as IDataObject[string],
					error: representation.message,
					...(representation.description && { description: representation.description }),
				},
				pairedItem: { item: itemIndex },
			});
		} else {
			results.push({ json: representation, pairedItem: { item: itemIndex } });
		}
	}

	return results;
}
