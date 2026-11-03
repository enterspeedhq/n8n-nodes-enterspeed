import type { INodeProperties } from 'n8n-workflow';
import * as get from './get.operation';

export const operations = { get };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['representation'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get a representation',
			description:
				"Read the representation served for a route, one request per item. Each slot's state is in $metadata; a route with no representation fails the item.",
		},
	],
	default: 'get',
};

export const description: INodeProperties[] = [operationSelector, ...get.properties];
