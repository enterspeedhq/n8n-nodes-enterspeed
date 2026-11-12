import type { INodeProperties } from 'n8n-workflow';
import * as query from './query.operation';

export const operations = { query };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['index'] } },
	options: [
		{
			name: 'Query',
			value: 'query',
			action: 'Query an index',
			description: 'Find records in an index with filters, sorting and paging. Each item is one query; all are sent in one request.',
		},
	],
	default: 'query',
};

export const description: INodeProperties[] = [operationSelector, ...query.properties];
