import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { API_VERSION, deliveryError } from '../shape/shared';

const show = { resource: ['schema'], operation: ['get'] };

export const properties: INodeProperties[] = [
	{
		displayName: 'Kind',
		name: 'kind',
		type: 'options',
		options: [
			{
				name: 'Materialised Schema (MSD)',
				value: 'msd',
				description: "The Context Graph's own schema document: indexes, representations and their slots",
			},
			{ name: 'OpenAPI 3.1', value: 'openapi', description: 'The same schema rendered as an OpenAPI 3.1 document' },
			{ name: 'JSON Schema', value: 'jsonschema', description: 'The same schema rendered as JSON Schema 2020-12' },
		],
		default: 'msd',
		description: 'Which form of the schema to read',
		displayOptions: { show },
	},
	{
		displayName: 'Prefix',
		name: 'prefix',
		type: 'string',
		default: '',
		placeholder: 'e.g. /products',
		description:
			'Only the representations with a route under this path. Leave empty for the whole schema. Indexes and the other parts are always included.',
		displayOptions: { show },
	},
];

/** The prefix as the route's tail: each segment percent-encoded, empty for none. */
function prefixPath(prefix: string): string {
	const segments = prefix.split('/').filter(Boolean);
	return segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : '';
}

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

/**
 * Reads the manifest's schema from `GET {deliveryUrl}/schema/{kind}/v1/{manifest}[/{prefix}]`
 * (delivery/ADR-030 §3, ADR-036 as amended by sc-11303 and sc-11038) and outputs
 * it unchanged as one item. The schema is per manifest, so the node reads it once
 * per run, with the first item's parameters.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const kind = this.getNodeParameter('kind', 0, 'msd') as string;
	const prefix = this.getNodeParameter('prefix', 0, '');
	if (typeof prefix !== 'string') {
		throw new NodeOperationError(this.getNode(), 'Prefix is not text.');
	}

	const url = `${creds.deliveryUrl}/schema/${encodeURIComponent(kind)}/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}${prefixPath(prefix)}`;
	let response: unknown;
	try {
		response = await contextGraphApiRequest.call(this, { method: 'GET', url, json: true });
	} catch (error) {
		const notFound = prefix.trim()
			? `No representation in the schema has a route under "${prefix}".`
			: `No schema of kind "${kind}" for manifest "${creds.manifestVersion}".`;
		const failure = deliveryError.call(this, error, creds, { notFound });
		if (!this.continueOnFail()) throw failure;
		return [
			{
				json: { kind, prefix, error: failure.message, ...(failure.description && { description: failure.description }) },
				pairedItem: { item: 0 },
			},
		];
	}

	const schema = asObject(response);
	if (!schema) {
		throw new NodeOperationError(this.getNode(), `The Delivery URL didn't answer with a "${kind}" schema document.`);
	}
	return [{ json: schema, pairedItem: { item: 0 } }];
}
