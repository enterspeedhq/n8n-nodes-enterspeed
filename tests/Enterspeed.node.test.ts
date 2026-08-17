import { describe, it, expect, vi } from 'vitest';
import type { IHttpRequestOptions } from 'n8n-workflow';
import { Enterspeed } from '../nodes/Enterspeed/Enterspeed.node';
import { createExecuteMock, defaultCreds } from './mocks';

/**
 * The action node's job is to translate node parameters into the correct HTTP
 * request. These tests mock `helpers.httpRequest`, run `execute`, and assert on
 * the request options it was called with (method, url, headers, body) — no
 * network, no real Enterspeed account.
 */

const node = new Enterspeed();

/** Run execute() with the given params/creds and return the captured request. */
async function run(opts: {
	params: Record<string, unknown>;
	creds?: Record<string, unknown>;
	response?: unknown;
	continueOnFail?: boolean;
	httpRequest?: ReturnType<typeof vi.fn>;
}): Promise<{ req: IHttpRequestOptions; result: unknown; httpRequest: ReturnType<typeof vi.fn> }> {
	const httpRequest =
		opts.httpRequest ?? vi.fn(async () => opts.response ?? { ok: true });
	const ctx = createExecuteMock({
		params: opts.params,
		creds: (opts.creds ?? defaultCreds) as never,
		httpRequest,
		continueOnFail: opts.continueOnFail,
	});
	const result = await node.execute.call(ctx);
	return { req: httpRequest.mock.calls[0]?.[0] as IHttpRequestOptions, result, httpRequest };
}

describe('Entity (Ingest)', () => {
	it('save: POSTs to /ingest/v2/{originId} with source key, type header and JSON body', async () => {
		const { req } = await run({
			params: {
				resource: 'entity',
				operation: 'save',
				originId: '1099-en-us',
				entityType: 'home',
				properties: { heroHeader: 'Hi' },
			},
		});
		expect(req.method).toBe('POST');
		expect(req.url).toBe('https://api.enterspeed.com/ingest/v2/1099-en-us');
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'source-key', 'X-Enterspeed-Type': 'home' });
		expect(req.body).toEqual({ heroHeader: 'Hi' });
	});

	it('save: parses a JSON string in the Properties field into an object body', async () => {
		const { req } = await run({
			params: {
				resource: 'entity',
				operation: 'save',
				originId: 'x',
				entityType: 'home',
				properties: '{"a":1}',
			},
		});
		expect(req.body).toEqual({ a: 1 });
	});

	it('save: url-encodes the origin id', async () => {
		const { req } = await run({
			params: { resource: 'entity', operation: 'save', originId: 'a/b c', entityType: 't', properties: {} },
		});
		expect(req.url).toBe('https://api.enterspeed.com/ingest/v2/a%2Fb%20c');
	});

	it('delete: DELETEs and sends no body or type header', async () => {
		const { req } = await run({
			params: { resource: 'entity', operation: 'delete', originId: '1099-en-us' },
		});
		expect(req.method).toBe('DELETE');
		expect(req.url).toBe('https://api.enterspeed.com/ingest/v2/1099-en-us');
		expect(req.body).toBeUndefined();
		expect(req.headers).not.toHaveProperty('X-Enterspeed-Type');
	});

	it('delete: merges deleted: true onto the raw API response', async () => {
		const { result } = await run({
			params: { resource: 'entity', operation: 'delete', originId: '1099-en-us' },
			response: { originId: '1099-en-us' },
		});
		expect(result).toEqual([[{ json: { originId: '1099-en-us', deleted: true }, pairedItem: { item: 0 } }]]);
	});

	it('delete: still reports deleted: true when the API responds with no body', async () => {
		const { result } = await run({
			params: { resource: 'entity', operation: 'delete', originId: '1099-en-us' },
			httpRequest: vi.fn(async () => undefined),
		});
		expect(result).toEqual([[{ json: { deleted: true }, pairedItem: { item: 0 } }]]);
	});

	it('throws when the source key is missing', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: { resource: 'entity', operation: 'save', originId: 'x', entityType: 't', properties: {} },
			creds: { ...defaultCreds, sourceApiKey: '' } as never,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/Source API Key is required/);
		expect(httpRequest).not.toHaveBeenCalled();
	});
});

describe('Entity (Ingest) - Bulk', () => {
	it('saveBulk: POSTs the entities array to /ingest/v2 with the source key', async () => {
		const entities = [{ originId: '1', type: 'product' }, { originId: '2', type: 'product' }];
		const { req } = await run({
			params: { resource: 'entity', operation: 'saveBulk', entities },
		});
		expect(req.method).toBe('POST');
		expect(req.url).toBe('https://api.enterspeed.com/ingest/v2');
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'source-key' });
		expect(req.headers).not.toHaveProperty('X-Enterspeed-Type');
		expect(req.body).toEqual(entities);
	});

	it('saveBulk: parses a JSON string in the Entities field into an array body', async () => {
		const { req } = await run({
			params: { resource: 'entity', operation: 'saveBulk', entities: '[{"originId":"1","type":"product"}]' },
		});
		expect(req.body).toEqual([{ originId: '1', type: 'product' }]);
	});

	it('saveBulk: rejects non-array input before sending a request', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: { resource: 'entity', operation: 'saveBulk', entities: { originId: '1' } },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/must be a JSON array/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('saveBulk: sends more than 50 entities as-is, leaving the limit to the API', async () => {
		const entities = Array.from({ length: 51 }, (_, idx) => ({ originId: String(idx), type: 'product' }));
		const { req } = await run({
			params: { resource: 'entity', operation: 'saveBulk', entities },
		});
		expect(req.body).toEqual(entities);
	});

	it('deleteBulk: DELETEs { originIds } to /ingest/v2 with the source key', async () => {
		const originIds = ['1099-en-us', '1100-en-us'];
		const { req } = await run({
			params: { resource: 'entity', operation: 'deleteBulk', originIds: { originIds } },
		});
		expect(req.method).toBe('DELETE');
		expect(req.url).toBe('https://api.enterspeed.com/ingest/v2');
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'source-key' });
		expect(req.body).toEqual({ originIds });
	});

	it('deleteBulk: parses a JSON string in the Delete Body field into { originIds }', async () => {
		const { req } = await run({
			params: { resource: 'entity', operation: 'deleteBulk', originIds: '{"originIds":["1099-en-us"]}' },
		});
		expect(req.body).toEqual({ originIds: ['1099-en-us'] });
	});

	it('deleteBulk: merges deleted: true onto the raw API response', async () => {
		const originIds = ['1099-en-us', '1100-en-us'];
		const { result } = await run({
			params: { resource: 'entity', operation: 'deleteBulk', originIds: { originIds } },
			response: { deletedCount: 2 },
		});
		expect(result).toEqual([[{ json: { deletedCount: 2, deleted: true }, pairedItem: { item: 0 } }]]);
	});

	it('deleteBulk: rejects a bare array — the field must match the API body shape { "originIds": [...] }', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: { resource: 'entity', operation: 'deleteBulk', originIds: ['1099-en-us', '1100-en-us'] },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/must be a JSON object in the form/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('deleteBulk: rejects an object without an originIds array before sending a request', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: { resource: 'entity', operation: 'deleteBulk', originIds: { originId: '1099-en-us' } },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/must be a JSON object in the form/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('surfaces a 422 bulk validation error with per-entity details via NodeApiError', async () => {
		const httpRequest = vi.fn(async () => {
			const error = new Error('Request failed with status code 422') as Error & {
				response: { status: number; data: unknown };
				constructor: { name: string };
			};
			Object.defineProperty(error.constructor, 'name', { value: 'AxiosError' });
			error.response = {
				status: 422,
				data: { message: 'All entities failed validation', errors: [{ originId: '1', error: 'type is required' }] },
			};
			throw error;
		});
		const ctx = createExecuteMock({
			params: { resource: 'entity', operation: 'saveBulk', entities: [{ originId: '1' }] },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/invalid or could not be processed/);
	});

	it('continueOnFail surfaces the parsed 422 description in the output instead of throwing', async () => {
		const httpRequest = vi.fn(async () => {
			const error = new Error('Request failed with status code 422') as Error & {
				response: { status: number; data: unknown };
				constructor: { name: string };
			};
			Object.defineProperty(error.constructor, 'name', { value: 'AxiosError' });
			error.response = {
				status: 422,
				data: { message: 'All entities failed validation' },
			};
			throw error;
		});
		const { result } = await run({
			params: { resource: 'entity', operation: 'saveBulk', entities: [{ originId: '1' }] },
			httpRequest,
			continueOnFail: true,
		});
		const [[output]] = result as [Array<{ json: { error: string; description?: string } }>];
		expect(output.json.error).toMatch(/invalid or could not be processed/);
		expect(output.json.description).toBe('All entities failed validation');
	});
});

describe('Delivery', () => {
	it('builds repeated query params (id=a&id=b) rather than indexed arrays', async () => {
		const { req } = await run({
			params: {
				resource: 'delivery',
				operation: 'get',
				url: 'https://site.com/p',
				ids: 'a, b ,c',
				handles: 'Navigation',
			},
		});
		expect(req.method).toBe('GET');
		expect(req.qs).toBeUndefined();
		const u = new URL(req.url);
		expect(u.pathname).toBe('/v2');
		expect(u.searchParams.get('url')).toBe('https://site.com/p');
		expect(u.searchParams.getAll('id')).toEqual(['a', 'b', 'c']);
		expect(u.searchParams.getAll('handle')).toEqual(['Navigation']);
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'env-key' });
	});

	it('omits the query string entirely when nothing is provided', async () => {
		const { req } = await run({
			params: { resource: 'delivery', operation: 'get', url: '', ids: '', handles: '' },
		});
		expect(req.url).toBe('https://delivery.enterspeed.com/v2');
	});
});

describe('Query', () => {
	it('POSTs the body to /v1/{indexAlias} with the environment key', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'query',
				indexAlias: 'productIndex',
				queryBody: { pagination: { page: 1, size: 50 } },
			},
		});
		expect(req.method).toBe('POST');
		expect(req.url).toBe('https://query.enterspeed.com/v1/productIndex');
		expect(req.body).toEqual({ pagination: { page: 1, size: 50 } });
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'env-key' });
	});

	it('parses a JSON string query body', async () => {
		const { req } = await run({
			params: { resource: 'query', operation: 'query', indexAlias: 'i', queryBody: '{"size":5}' },
		});
		expect(req.body).toEqual({ size: 5 });
	});

	it('Using Fields: assembles filters (AND), sort, facets, search, pagination and aliases', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'query',
				indexAlias: 'productIndex',
				specifyQuery: 'fields',
				filtersCombinator: 'and',
				filtersUi: {
					condition: [
						{ field: 'title', operator: 'contains', value: '*hoodie*', caseInsensitive: true },
						{ field: 'isInStock', operator: 'equals', value: true },
					],
				},
				sortUi: { item: [{ field: 'price', order: 'asc' }] },
				facetsUi: { item: [{ field: 'category', name: 'Categories', size: 20 }] },
				queryOptions: {
					searchField: 'title',
					searchValue: 'hoodie',
					searchLiteral: false,
					page: 0,
					pageSize: 20,
					aliases: 'productTile, navigation',
				},
			},
		});
		expect(req.body).toEqual({
			filters: {
				and: [
					{ field: 'title', operator: 'contains', value: '*hoodie*', caseInsensitive: true },
					{ field: 'isInStock', operator: 'equals', value: true },
				],
			},
			sort: [{ field: 'price', order: 'asc' }],
			facets: [{ field: 'category', name: 'Categories', size: 20 }],
			search: { field: 'title', value: 'hoodie', literal: false },
			pagination: { page: 0, pageSize: 20 },
			aliases: ['productTile', 'navigation'],
		});
	});

	it('Using Fields: wraps conditions in "or" when the combinator is OR', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'query',
				indexAlias: 'productIndex',
				specifyQuery: 'fields',
				filtersCombinator: 'or',
				filtersUi: { condition: [{ field: 'isInStock', operator: 'equals', value: true }] },
			},
		});
		expect(req.body).toEqual({
			filters: { or: [{ field: 'isInStock', operator: 'equals', value: true }] },
		});
	});

	it('Using Fields: sends a non-empty JSON payload when no fields are configured', async () => {
		const { req } = await run({
			params: { resource: 'query', operation: 'query', indexAlias: 'i', specifyQuery: 'fields' },
		});
		// An empty object is forced into a literal (but still valid) JSON string so the
		// HTTP layer doesn't drop the body entirely — see query.operation.ts.
		expect(req.body).toBe('{\n}\n');
	});
});

describe('Multi Query Items', () => {
	it('POSTs an array of queries to /v1 with the environment key', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'queryMulti',
				'queries.query': [
					{
						indexAlias: 'productIndex',
						name: 'products',
						specifyQuery: 'fields',
						filtersCombinator: 'and',
						filtersUi: { condition: [{ field: 'isInStock', operator: 'equals', value: true }] },
					},
					{
						indexAlias: 'categoryIndex',
						name: 'categories',
						specifyQuery: 'json',
						queryBody: { pagination: { page: 0, pageSize: 5 } },
					},
				],
			},
		});
		expect(req.method).toBe('POST');
		expect(req.url).toBe('https://query.enterspeed.com/v1');
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'env-key' });
		expect(req.body).toEqual([
			{
				index: 'productIndex',
				name: 'products',
				filters: { and: [{ field: 'isInStock', operator: 'equals', value: true }] },
			},
			{ index: 'categoryIndex', name: 'categories', pagination: { page: 0, pageSize: 5 } },
		]);
	});

	it('parses a JSON string query body for a "Using JSON" entry', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'queryMulti',
				'queries.query': [
					{ indexAlias: 'i', name: 'n', specifyQuery: 'json', queryBody: '{"size":5}' },
				],
			},
		});
		expect(req.body).toEqual([{ index: 'i', name: 'n', size: 5 }]);
	});

	it('Using JSON: POSTs the raw queries array as-is, bypassing the Queries fixedCollection', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'queryMulti',
				specifyQuery: 'json',
				queryBody: [
					{ index: 'productIndex', name: 'products', pagination: { page: 1, size: 50 } },
					{ index: 'categoryIndex', name: 'categories' },
				],
			},
		});
		expect(req.method).toBe('POST');
		expect(req.url).toBe('https://query.enterspeed.com/v1');
		expect(req.body).toEqual([
			{ index: 'productIndex', name: 'products', pagination: { page: 1, size: 50 } },
			{ index: 'categoryIndex', name: 'categories' },
		]);
	});

	it('Using JSON: parses a JSON string in Queries (JSON) into the request body', async () => {
		const { req } = await run({
			params: {
				resource: 'query',
				operation: 'queryMulti',
				specifyQuery: 'json',
				queryBody: '[{"index":"i","name":"n"}]',
			},
		});
		expect(req.body).toEqual([{ index: 'i', name: 'n' }]);
	});

	it('Using JSON: rejects non-array input before sending a request', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: { resource: 'query', operation: 'queryMulti', specifyQuery: 'json', queryBody: { index: 'i' } },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/must be a JSON array/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('Using JSON: rejects more than the max allowed queries before sending a request', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: {
				resource: 'query',
				operation: 'queryMulti',
				specifyQuery: 'json',
				queryBody: Array.from({ length: 6 }, (_, idx) => ({ index: 'i', name: `n${idx}` })),
			},
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/maximum of 5 queries/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('fans each result out to its own output item', async () => {
		const { result } = await run({
			params: {
				resource: 'query',
				operation: 'queryMulti',
				'queries.query': [{ indexAlias: 'i', name: 'n', specifyQuery: 'fields' }],
			},
			response: [
				{ name: 'products', status: 200, results: [] },
				{ name: 'categories', status: 200, results: [] },
			],
		});
		expect(result).toEqual([
			[
				{ json: { name: 'products', status: 200, results: [] }, pairedItem: { item: 0 } },
				{ json: { name: 'categories', status: 200, results: [] }, pairedItem: { item: 0 } },
			],
		]);
	});

	it('rejects when no queries are configured', async () => {
		const httpRequest = vi.fn();
		const ctx = createExecuteMock({
			params: { resource: 'query', operation: 'queryMulti' },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/At least one query is required/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('rejects more than 5 queries before sending a request', async () => {
		const httpRequest = vi.fn();
		const queries = Array.from({ length: 6 }, (_, idx) => ({ indexAlias: 'i', name: `q${idx}` }));
		const ctx = createExecuteMock({
			params: { resource: 'query', operation: 'queryMulti', 'queries.query': queries },
			creds: defaultCreds,
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toThrow(/maximum of 5 queries/);
		expect(httpRequest).not.toHaveBeenCalled();
	});
});

describe('Route', () => {
	it('GETs /routes/v2 with the environment key', async () => {
		const { req } = await run({
			params: { resource: 'route', operation: 'getAll' },
		});
		expect(req.method).toBe('GET');
		expect(req.url).toBe('https://api.enterspeed.com/routes/v2');
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'env-key' });
		expect(req.headers?.['X-Continuation-Token']).toBeUndefined();
	});

	it('sends the continuation token header when provided', async () => {
		const { req } = await run({
			params: { resource: 'route', operation: 'getAll', continuationToken: 'token-123' },
		});
		expect(req.url).toBe('https://api.enterspeed.com/routes/v2');
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'env-key', 'X-Continuation-Token': 'token-123' });
	});
});

describe('host overrides and error handling', () => {
	it('falls back to default hosts when the credential omits them', async () => {
		const { req } = await run({
			params: { resource: 'route', operation: 'getAll', first: 100 },
			creds: { environmentApiKey: 'env-key' },
		});
		expect(req.url).toBe('https://api.enterspeed.com/routes/v2');
	});

	it('honours a custom delivery host', async () => {
		const { req } = await run({
			params: { resource: 'delivery', operation: 'get', url: '', ids: '', handles: '' },
			creds: { ...defaultCreds, deliveryHost: 'https://eu.delivery.enterspeed.com' },
		});
		expect(req.url).toBe('https://eu.delivery.enterspeed.com/v2');
	});

	it('continueOnFail captures the error as output instead of throwing', async () => {
		const httpRequest = vi.fn(async () => {
			throw new Error('boom');
		});
		const { result } = await run({
			params: { resource: 'route', operation: 'getAll', first: 100 },
			httpRequest,
			continueOnFail: true,
		});
		expect(result).toEqual([[{ json: { error: 'boom' }, pairedItem: { item: 0 } }]]);
	});
});
