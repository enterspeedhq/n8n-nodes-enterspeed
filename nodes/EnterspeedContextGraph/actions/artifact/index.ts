import type { INodeProperties } from 'n8n-workflow';
import * as upload from './upload.operation';

export const operations = { upload };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['artifact'] } },
	options: [
		{
			name: 'Upload',
			value: 'upload',
			action: 'Upload a complete export',
			description: "Upload a source's complete export file (CSV or NDJSON) as it is, one file per item",
		},
	],
	default: 'upload',
};

export const description: INodeProperties[] = [operationSelector, ...upload.properties];
