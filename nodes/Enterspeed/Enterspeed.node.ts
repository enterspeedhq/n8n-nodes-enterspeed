import type { IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { router } from './actions/router';
import * as entity from './actions/entity';
import * as delivery from './actions/delivery';
import * as query from './actions/query';
import * as route from './actions/route';

const resourceSelector: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Entity (Ingest)', value: 'entity' },
		{ name: 'Delivery', value: 'delivery' },
		{ name: 'Query', value: 'query' },
		{ name: 'Route', value: 'route' },
	],
	default: 'delivery',
};

/**
 * Enterspeed action node.
 *
 * Resources:
 *  - Entity   (Ingest API)   : save / delete a source entity
 *  - Delivery (Delivery API) : get content by URL, IDs or handles
 *  - Query    (Query API)    : query an index
 *  - Route    (Routes API)   : list all routes for an environment
 *
 * Each resource's properties and execute logic live under ./actions/<resource>;
 * execute() below just delegates to ./actions/router.
 */
export class Enterspeed implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed',
		name: 'enterspeed',
		icon: 'file:enterspeed.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Ingest, deliver and query data through Enterspeed',
		defaults: { name: 'Enterspeed' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'enterspeedApi', required: true }],
		codex: {
			categories: ['Data & Storage', 'Development'],
			subcategories: {
				'Data & Storage': ['Content Management'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://docs.enterspeed.com' }],
			},
		},
		properties: [
			resourceSelector,
			...entity.description,
			...delivery.description,
			...query.description,
			...route.description,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return router.call(this);
	}
}
