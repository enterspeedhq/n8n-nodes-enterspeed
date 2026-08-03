import type { INodeProperties } from 'n8n-workflow';
import * as get from './get.operation';

export const operations = { get };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['delivery'] } },
	options: [{ name: 'Get Content', value: 'get', action: 'Get content' }],
	default: 'get',
};

export const description: INodeProperties[] = [operationSelector, ...get.properties];
