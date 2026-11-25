import type { INodeProperties } from 'n8n-workflow';
import { MAX_BULK_ENTITIES } from './shared';
import * as save from './save.operation';
import * as del from './delete.operation';
import * as saveBulk from './saveBulk.operation';
import * as deleteBulk from './deleteBulk.operation';

export const operations = { save, delete: del, saveBulk, deleteBulk };

const operationSelector: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['entity'] } },
	options: [
		{ name: 'Save', value: 'save', action: 'Save entity', description: 'Ingest / update a source entity' },
		{
			name: 'Delete',
			value: 'delete',
			action: 'Delete entity',
			description: 'Delete a source entity permanently',
		},
		{
			name: 'Save Entities (Bulk)',
			value: 'saveBulk',
			action: 'Save entities in bulk',
			description: `Ingest / update up to ${MAX_BULK_ENTITIES} source entities in one call`,
		},
		{
			name: 'Delete Entities (Bulk)',
			value: 'deleteBulk',
			action: 'Delete entities in bulk',
			description: `Delete up to ${MAX_BULK_ENTITIES} source entities in one call`,
		},
	],
	default: 'save',
};

export const description: INodeProperties[] = [
	operationSelector,
	...save.properties,
	...del.properties,
	...saveBulk.properties,
	...deleteBulk.properties,
];
