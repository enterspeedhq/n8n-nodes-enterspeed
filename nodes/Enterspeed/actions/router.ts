import type { IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import * as entity from './entity';
import * as delivery from './delivery';
import * as query from './query';
import * as route from './route';
import type { EnterspeedCredentials } from './types';

interface OperationHandler {
	execute(
		this: IExecuteFunctions,
		itemIndex: number,
		creds: EnterspeedCredentials,
	): Promise<INodeExecutionData[]>;
}

const resources: Record<string, { operations: Record<string, OperationHandler> }> = {
	entity,
	delivery,
	query,
	route,
};

export async function router(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	const items = this.getInputData();
	const out: INodeExecutionData[] = [];

	const creds = await this.getCredentials('enterspeedApi');
	const context: EnterspeedCredentials = {
		envKey: creds.environmentApiKey as string,
		sourceKey: creds.sourceApiKey as string,
		ingestHost: (creds.ingestHost as string) ?? 'https://api.enterspeed.com',
		deliveryHost: (creds.deliveryHost as string) ?? 'https://delivery.enterspeed.com',
		queryHost: (creds.queryHost as string) ?? 'https://query.enterspeed.com',
	};

	const resource = this.getNodeParameter('resource', 0) as string;
	const operation = this.getNodeParameter('operation', 0) as string;
	const handler = resources[resource].operations[operation];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			out.push(...(await handler.execute.call(this, itemIndex, context)));
		} catch (error) {
			const nodeError =
				error instanceof NodeOperationError
					? error
					: new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
			if (this.continueOnFail()) {
				out.push({
					json: { error: nodeError.message, description: nodeError.description },
					pairedItem: { item: itemIndex },
				});
				continue;
			}
			throw nodeError;
		}
	}

	return [out];
}
