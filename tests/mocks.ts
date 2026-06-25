import { vi, type Mock } from 'vitest';
import type { IExecuteFunctions, IPollFunctions, IDataObject } from 'n8n-workflow';

type ParamMap = Record<string, unknown>;

/**
 * Builds a minimal IExecuteFunctions stand-in for the Enterspeed action node.
 * Parameters are looked up by name (the item index is ignored, which is fine
 * since the tests use a single set of values per case).
 */
export function createExecuteMock(opts: {
	params: ParamMap;
	creds: IDataObject;
	items?: IDataObject[];
	httpRequest: Mock;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const items = (opts.items ?? [{}]).map((json) => ({ json }));
	return {
		getInputData: () => items,
		getCredentials: vi.fn(async () => opts.creds),
		getNodeParameter: (name: string) => opts.params[name],
		getNode: () => ({ name: 'Enterspeed' }),
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: { httpRequest: opts.httpRequest },
	} as unknown as IExecuteFunctions;
}

/**
 * Builds a minimal IPollFunctions stand-in for the trigger. `staticData` is a
 * live object so change-detection state persists across successive poll() calls.
 */
export function createPollMock(opts: {
	params: ParamMap;
	creds: IDataObject;
	httpRequest: Mock;
	staticData?: IDataObject;
}): { ctx: IPollFunctions; staticData: IDataObject } {
	const staticData = opts.staticData ?? {};
	const ctx = {
		getCredentials: vi.fn(async () => opts.creds),
		getNodeParameter: (name: string) => opts.params[name],
		getNode: () => ({ name: 'Enterspeed Trigger' }),
		getWorkflowStaticData: () => staticData,
		helpers: { httpRequest: opts.httpRequest },
	} as unknown as IPollFunctions;
	return { ctx, staticData };
}

export const defaultCreds: IDataObject = {
	environmentApiKey: 'env-key',
	sourceApiKey: 'source-key',
	ingestHost: 'https://api.enterspeed.com',
	deliveryHost: 'https://delivery.enterspeed.com',
	queryHost: 'https://query.enterspeed.com',
};
