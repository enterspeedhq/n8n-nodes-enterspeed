import type { INodeProperties } from 'n8n-workflow';
import * as getAll from './getAll.operation';

export const operations = { getAll };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['route'] } },
	options: [{ name: 'Get Many', value: 'getAll', action: 'Get many routes for the environment' }],
	default: 'getAll',
};

export const description: INodeProperties[] = [operationSelector, ...getAll.properties];
