import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, NodeApiError } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { API_VERSION, deliveryError } from '../shape/shared';
import { parseContextFieldId, routeSegments } from '../schema/msd';

const show = { resource: ['representation'], operation: ['get'] };
const fromSchema = { ...show, routeFrom: ['schema'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Route From',
		name: 'routeFrom',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Schema',
				value: 'schema',
				description: "Choose a representation and route from the manifest's schema, and give its values",
			},
			{ name: 'Route', value: 'route', description: 'Give the whole route path as text' },
		],
		default: 'route',
		description: 'How the route is given',
		displayOptions: { show },
	},
	{
		displayName: 'Representation Name or ID',
		name: 'representation',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getRepresentations' },
		default: '',
		required: true,
		description:
			'The representation to read, from the schema of the manifest. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: fromSchema },
	},
	{
		displayName: 'Route Name or ID',
		name: 'representationRoute',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getRepresentationRoutes', loadOptionsDependsOn: ['representation'] },
		default: '',
		required: true,
		description:
			'Which of the routes of the representation to read. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: fromSchema },
	},
	{
		displayName: 'Context',
		name: 'context',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		typeOptions: {
			loadOptionsDependsOn: ['representation', 'representationRoute'],
			resourceMapper: {
				resourceMapperMethod: 'getRouteValues',
				mode: 'add',
				fieldWords: { singular: 'value', plural: 'values' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
			},
		},
		description:
			"The values the representation's slots read: each route placeholder, then the other context the schema lists. Path values fill the route; the rest go in the query string or a header, as the schema declares.",
		displayOptions: { show: fromSchema },
	},
	{
		displayName: 'Route',
		name: 'route',
		type: 'string',
		default: '={{ $json.route }}',
		required: true,
		placeholder: 'e.g. /products/42',
		displayOptions: { show: { ...show, routeFrom: ['route'] } },
		description: "The representation's route path, starting with a slash, as the schema declares it",
	},
];

/** A request built from the schema: the route's segments, unencoded, plus query string and headers. */
export interface SchemaRequest {
	segments: string[];
	qs: IDataObject;
	headers: IDataObject;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Fills a route template from the context values (field id `path:`, `query:`
 * or `header:` plus the name). Returns why it can't when a path value or a
 * required value is missing. Empty optional values are left out.
 */
export function buildSchemaRequest(
	template: string,
	values: IDataObject,
	fields: Array<{ id: string; required?: boolean }>,
): SchemaRequest | string {
	const request: SchemaRequest = { segments: [], qs: {}, headers: {} };
	for (const segment of routeSegments(template)) {
		if ('literal' in segment) {
			request.segments.push(segment.literal);
			continue;
		}
		const value = values[`path:${segment.placeholder}`];
		if (isEmpty(value)) return `has no value for "${segment.placeholder}"`;
		request.segments.push(String(value));
	}
	for (const field of fields) {
		const target = parseContextFieldId(field.id);
		if (!target || target.target === 'path') continue;
		const value = values[field.id];
		if (isEmpty(value)) {
			if (field.required) return `has no value for "${target.name}"`;
			continue;
		}
		(target.target === 'header' ? request.headers : request.qs)[target.name] = value as IDataObject[string];
	}
	return request;
}

/** The item's route, as given, or the request filled from the schema's route template. */
function itemRequest(this: IExecuteFunctions, itemIndex: number): { route: unknown; request?: SchemaRequest | string } {
	if (this.getNodeParameter('routeFrom', itemIndex, 'route') !== 'schema') {
		return { route: this.getNodeParameter('route', itemIndex, undefined) };
	}
	const template = this.getNodeParameter('representationRoute', itemIndex, '') as string;
	if (!template) return { route: template, request: 'has no Route' };
	const values = (this.getNodeParameter('context.value', itemIndex, {}) ?? {}) as IDataObject;
	const fields = (this.getNodeParameter('context.schema', itemIndex, []) ?? []) as Array<{ id: string; required?: boolean }>;
	return { route: template, request: buildSchemaRequest(template, values, fields) };
}

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
	request?: SchemaRequest | string,
): Promise<IDataObject | NodeApiError | NodeOperationError> {
	const problem = typeof request === 'string' ? request : request ? undefined : invalidRoute(route);
	if (problem) return new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });
	const fromSchema = typeof request === 'object' ? request : undefined;

	let response: unknown;
	try {
		// 200, 202 and 207 all carry the body; which slots resolved is in
		// $metadata.<slot>.$state, not the status (Representation envelope).
		response = await contextGraphApiRequest.call(this, {
			method: 'GET',
			url: fromSchema
				? `${creds.deliveryUrl}/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}/${fromSchema.segments.map(encodeURIComponent).join('/')}`
				: representationUrl(creds, route as string),
			...(fromSchema && Object.keys(fromSchema.qs).length && { qs: fromSchema.qs }),
			...(fromSchema && Object.keys(fromSchema.headers).length && { headers: fromSchema.headers }),
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
		const { route, request } = itemRequest.call(this, itemIndex);
		const representation = await readRepresentation.call(this, route, itemIndex, creds, request);
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
