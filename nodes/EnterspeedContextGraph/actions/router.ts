import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import * as entity from './entity';
import type { ContextGraphCredentials } from './types';

/**
 * Unlike Core's router, handlers receive every input item at once: Push Many
 * outputs one result per record, not per item, so it can't run one item at a
 * time.
 */
interface OperationHandler {
	execute(this: IExecuteFunctions, creds: ContextGraphCredentials): Promise<INodeExecutionData[]>;
}

const resources: Record<string, { operations: Record<string, OperationHandler> }> = {
	entity,
};

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export async function router(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const creds = await this.getCredentials('enterspeedContextGraphApi');
	const context: ContextGraphCredentials = {
		ingestUrl: trimSlash(creds.ingestUrl as string),
		deliveryUrl: trimSlash(creds.deliveryUrl as string),
		manifestVersion: creds.manifestVersion as string,
	};

	const resource = this.getNodeParameter('resource', 0) as string;
	const operation = this.getNodeParameter('operation', 0) as string;
	const handler = resources[resource].operations[operation];

	return [await handler.execute.call(this, context)];
}
