import type { INodeProperties } from 'n8n-workflow';
import { MAX_MULTI_QUERIES } from './shared';
import * as query from './query.operation';
import * as queryMulti from './queryMulti.operation';

export const operations = { query, queryMulti };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['query'] } },
	options: [
		{
			name: 'Query Items',
			value: 'query',
			action: 'Query items in index',
			description: 'Query a single index',
		},
		{
			name: 'Multi Query Items',
			value: 'queryMulti',
			action: 'Query multiple indices in one call',
			description: `Run up to ${MAX_MULTI_QUERIES} queries in a single request`,
		},
	],
	default: 'query',
};

export const description: INodeProperties[] = [operationSelector, ...query.properties, ...queryMulti.properties];
