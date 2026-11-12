import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, NodeApiError } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { deliveryError, failedItem, invalidKey, shapeKeyProperty, shapesUrl } from './shared';

const show = { resource: ['shape'], operation: ['get', 'getMany'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Key From',
		name: 'keyFrom',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Schema',
				value: 'schema',
				description: "Choose a shape from the manifest's schema and give a value for each of its ID segments",
			},
			{ name: 'Shape Key', value: 'shapeKey', description: 'Give the whole key as text (Get) or a list of keys (Get Many)' },
		],
		default: 'shapeKey',
		description: 'How the shape key is given',
		displayOptions: { show },
	},
	{
		displayName: 'Shape Name or ID',
		name: 'shapeName',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getSchemaShapes' },
		default: '',
		required: true,
		description:
			'The shape to read, from the schema of the manifest. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: { ...show, keyFrom: ['schema'] } },
	},
	{
		displayName: 'ID Segments',
		name: 'idSegments',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		typeOptions: {
			loadOptionsDependsOn: ['shapeName'],
			resourceMapper: {
				resourceMapperMethod: 'getShapeSegments',
				mode: 'add',
				fieldWords: { singular: 'segment', plural: 'segments' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
			},
		},
		description: "A value for each of the shape's ID segments: the record's own data (e.g. its ID)",
		displayOptions: { show: { ...show, keyFrom: ['schema'] } },
	},
	shapeKeyProperty,
];

/**
 * The key built from the chosen shape and its segment values:
 * `{shapeName}:{segKey}:{value}:…` (Shape key contract), the segments in the
 * order the schema gives them. Undefined if a segment has no value.
 */
export function buildShapeKey(shapeName: string, segments: string[], values: IDataObject): string | undefined {
	const parts = [shapeName];
	for (const segment of segments) {
		const value = values[segment];
		if (value === undefined || value === null || value === '') return undefined;
		parts.push(segment, String(value));
	}
	return parts.join(':');
}

/** The item's key built from the schema's shape and its segment values. */
export function schemaKey(this: IExecuteFunctions, itemIndex: number): string | undefined {
	const shapeName = this.getNodeParameter('shapeName', itemIndex, '') as string;
	const values = (this.getNodeParameter('idSegments.value', itemIndex, {}) ?? {}) as IDataObject;
	// The mapper's fields are the schema's segments, in the schema's order.
	const schema = (this.getNodeParameter('idSegments.schema', itemIndex, []) ?? []) as Array<{ id: string }>;
	return buildShapeKey(shapeName, schema.map((f) => f.id), values);
}

/** The item's key: as given, or built from the schema's shape and the item's segment values. */
function itemKey(this: IExecuteFunctions, itemIndex: number): unknown {
	if (this.getNodeParameter('keyFrom', itemIndex, 'shapeKey') !== 'schema') {
		return this.getNodeParameter('shapeKey', itemIndex, undefined);
	}
	return schemaKey.call(this, itemIndex);
}

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
		const key = itemKey.call(this, itemIndex);
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
