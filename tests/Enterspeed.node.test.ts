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
});

describe('Route', () => {
	it('GETs /routes/v1 with the page size and environment key', async () => {
		const { req } = await run({
			params: { resource: 'route', operation: 'getAll', first: 100 },
		});
		expect(req.method).toBe('GET');
		expect(req.url).toBe('https://api.enterspeed.com/routes/v1');
		expect(req.qs).toEqual({ first: 100 });
		expect(req.headers).toMatchObject({ 'X-Api-Key': 'env-key' });
	});
});

describe('host overrides and error handling', () => {
	it('falls back to default hosts when the credential omits them', async () => {
		const { req } = await run({
			params: { resource: 'route', operation: 'getAll', first: 100 },
			creds: { environmentApiKey: 'env-key' },
		});
		expect(req.url).toBe('https://api.enterspeed.com/routes/v1');
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
