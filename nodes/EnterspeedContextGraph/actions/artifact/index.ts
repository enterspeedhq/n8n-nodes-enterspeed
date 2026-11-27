import type { INodeProperties } from 'n8n-workflow';
import * as get from './get.operation';
import * as getLines from './getLines.operation';
import * as getMany from './getMany.operation';
import * as upload from './upload.operation';

export const operations = { get, getLines, getMany, upload };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['artifact'] } },
	options: [
		{
			name: 'Get',
			value: 'get',
			action: 'Get an artifact',
			description: "Read an upload's state and drain result, one artifact per item",
		},
		{
			name: 'Get Lines',
			value: 'getLines',
			action: 'Get the lines of an artifact that did not land',
			description: "Output each record of an upload that didn't land (refused, failed or unparseable), one item each",
		},
		{
			name: 'Get Many',
			value: 'getMany',
			action: 'Get many artifacts',
			description: "List a source's uploads, newest first, optionally only in one state",
		},
		{
			name: 'Upload',
			value: 'upload',
			action: 'Upload a complete export',
			description: "Upload a source's complete export file (CSV or NDJSON) as it is, one file per item",
		},
	],
	default: 'upload',
};

export const description: INodeProperties[] = [
	operationSelector,
	...upload.properties,
	...get.properties,
	...getMany.properties,
	...getLines.properties,
];
