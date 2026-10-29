import type { INodeProperties } from 'n8n-workflow';
import * as push from './push.operation';
import * as pushMany from './pushMany.operation';

export const operations = { push, pushMany };

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
			action: 'Push an entity',
			description: 'Save or delete one record per item, one request per item',
		},
		{
			name: 'Push Many',
			value: 'pushMany',
			action: 'Push many entities',
			description: 'Save or delete a list of records in one request. Collect them into one item with an Aggregate node first.',
		},
	],
	default: 'push',
};

export const description: INodeProperties[] = [operationSelector, ...push.properties, ...pushMany.properties];
