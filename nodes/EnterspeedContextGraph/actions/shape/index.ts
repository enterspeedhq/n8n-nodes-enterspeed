import type { INodeProperties } from 'n8n-workflow';
import * as get from './get.operation';
import * as getMany from './getMany.operation';

export const operations = { get, getMany };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['shape'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get a shape',
			description: 'Read one shape by key, one request per item. A key with no shape fails the item.',
		},
		{
			name: 'Get Many',
			value: 'getMany',
			action: 'Get many shapes',
			description:
				'Read a list of shapes in one request. Each comes out with its key, status and data; a key with no shape has status 404.',
		},
	],
	default: 'get',
};

export const description: INodeProperties[] = [operationSelector, ...get.properties, ...getMany.properties];
