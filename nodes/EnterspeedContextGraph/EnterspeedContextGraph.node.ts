import type { IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { router } from './actions/router';
import * as entity from './actions/entity';
import * as shape from './actions/shape';

const resourceSelector: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Entity', value: 'entity' },
		{ name: 'Shape', value: 'shape' },
	],
	default: 'entity',
};

/**
 * Enterspeed Context Graph action node.
 *
 * Uses its own credential (`enterspeedContextGraphApi`).
 *
 * Resources:
 *  - Entity (Ingest)  : push records as source entities (save or delete), one
 *                       per item (Push) or a list in one item (Push Many)
 *  - Shape (Delivery) : read shapes by key, one per item (Get) or a list
 *                       in one item (Get Many)
 *
 * Each resource's properties and execute logic live under ./actions/<resource>;
 * execute() below just delegates to ./actions/router.
 */
export class EnterspeedContextGraph implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed Context Graph',
		name: 'enterspeedContextGraph',
		icon: { light: 'file:enterspeed.svg', dark: 'file:enterspeed.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Upload to and read from an Enterspeed Context Graph',
		defaults: { name: 'Enterspeed Context Graph' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'enterspeedContextGraphApi', required: true }],
		codex: {
			categories: ['Data & Storage', 'Development'],
			subcategories: {
				'Data & Storage': ['Content Management'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://docs.enterspeed.com' }],
			},
		},
		properties: [resourceSelector, ...entity.description, ...shape.description],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return router.call(this);
	}
}
