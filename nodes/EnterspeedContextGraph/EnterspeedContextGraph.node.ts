import type { IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { router } from './actions/router';
import * as entity from './actions/entity';

const resourceSelector: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [{ name: 'Entity', value: 'entity' }],
	default: 'entity',
};

/**
 * Enterspeed Context Graph action node.
 *
 * A sibling of Enterspeed Core with its own credential
 * (`enterspeedContextGraphApi`), so a workflow can never send Context Graph
 * calls with a Core key or the other way round.
 *
 * Resources:
 *  - Entity (Ingest) : push input items as source entities (save or delete)
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
		properties: [resourceSelector, ...entity.description],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return router.call(this);
	}
}
