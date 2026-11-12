import type { INodeProperties } from 'n8n-workflow';
import * as get from './get.operation';

export const operations = { get };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['schema'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get the schema',
			description: "Read the manifest's schema document, once per run",
		},
	],
	default: 'get',
};

export const description: INodeProperties[] = [operationSelector, ...get.properties];
