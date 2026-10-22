import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

/**
 * Enterspeed Context Graph action node.
 *
 * A sibling of Enterspeed Core with its own credential
 * (`enterspeedContextGraphApi`), so a workflow can never send Context Graph
 * calls with a Core key or the other way round. It has no operations yet;
 * execute() fails with a clear message until the first one lands.
 */
export class EnterspeedContextGraph implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed Context Graph',
		name: 'enterspeedContextGraph',
		icon: { light: 'file:enterspeed.svg', dark: 'file:enterspeed.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: 'No operations yet',
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
		properties: [
			{
				displayName:
					'This node has no operations yet. Upload and read operations are coming in a later release.',
				name: 'noOperationsNotice',
				type: 'notice',
				default: '',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		throw new NodeOperationError(
			this.getNode(),
			'Enterspeed Context Graph has no operations yet, so there is nothing to run.',
		);
	}
}
