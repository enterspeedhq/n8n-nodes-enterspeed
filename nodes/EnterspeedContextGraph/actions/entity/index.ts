import type { INodeProperties } from 'n8n-workflow';
import * as push from './push.operation';

export const operations = { push };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['entity'] } },
	options: [
		{
			name: 'Push',
			value: 'push',
			action: 'Push entities',
			description: 'Save or delete the input items as source entities',
		},
	],
	default: 'push',
};

export const description: INodeProperties[] = [operationSelector, ...push.properties];
