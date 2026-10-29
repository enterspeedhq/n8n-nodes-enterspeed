import { describe, it, expect, vi } from 'vitest';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import { EnterspeedContextGraph } from '../nodes/EnterspeedContextGraph/EnterspeedContextGraph.node';
import {
	MAX_REQUEST_BYTES,
	MAX_THROTTLE_RETRIES,
} from '../nodes/EnterspeedContextGraph/actions/entity/push.operation';
import { EnterspeedContextGraphApi } from '../credentials/EnterspeedContextGraphApi.credentials';
import { createContextGraphExecuteMock } from './mocks';

// Retry waits (ingest/ADR-020 Retry-After) resolve at once, and are recorded.
const { sleep } = vi.hoisted(() => ({ sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}) }));
vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep,
}));

/**
 * Push sends each input item, as the record it is, to `POST {ingestUrl}/entities`
 * (one NDJSON line per item, per the Context Graph's Ingest NDJSON contract)
 * and outputs one result per item. The service answers a per-line
 * `{ id, accepted, error?, statusCode }` array in line order, with 200 when
 * every line is accepted and 207 otherwise.
 */

const node = new EnterspeedContextGraph();
const credential = new EnterspeedContextGraphApi();

// Verbatim records from the Tonevik example (semantic-graph-sdk, dev-server
// examples). $id is the source system's record key, deliberately unrelated to
// the domain `id`; pricing has no `id` at all.
const pimCategory = { $id: 'pim-cat-dd34d4', $type: 'category', $source: 'pim', id: 'cat-speakers', name: 'Speakers' };
const navPricing = {
	$id: 'nav-prc-541690',
	$type: 'pricing',
	$source: 'nav',
	sku: 'AUR-HP-100',
	basePrice: 2499,
	salePrice: 1999,
	currency: 'DKK',
};
const pimDelete = { $id: 'pim-prd-2005f2', $type: 'product', $source: 'pim', $action: 'delete' };

/** Answers every request with one accepted result per NDJSON line. */
function acceptAll() {
	return vi.fn(async (req: IDataObject) =>
		ndjsonLines(req).map((line) => ({ id: line.$id, accepted: true, statusCode: 200 })),
	);
}

function ndjsonLines(req: IDataObject): IDataObject[] {
	return (req.body as string)
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as IDataObject);
}

const sent = (httpRequest: ReturnType<typeof vi.fn>, call = 0) =>
	ndjsonLines(httpRequest.mock.calls[call][0] as IDataObject);

async function push(opts: {
	params?: Record<string, unknown>;
	items?: IDataObject[];
	httpRequest?: ReturnType<typeof vi.fn>;
	continueOnFail?: boolean;
}) {
	const items = opts.items ?? [pimCategory];
	const httpRequest = opts.httpRequest ?? acceptAll();
	const ctx = createContextGraphExecuteMock({
		params: {
			resource: 'entity',
			operation: 'push',
			// What the fields' default expressions ({{ $json.$id }} etc.) resolve to.
			entityId: (i: number) => items[i].$id,
			entityType: (i: number) => items[i].$type,
			source: (i: number) => items[i].$source,
			action: (i: number) => items[i].$action,
			modifiedAt: (i: number) => items[i].$modifiedAt,
			...opts.params,
		},
		items,
		httpRequest,
		continueOnFail: opts.continueOnFail,
	});
	const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
	return { out, httpRequest };
}

/** Records of ~12 MiB: two fit in one request, a third starts the next. */
const big = (n: number) =>
	Array.from({ length: n }, (_, i) => ({ $id: `big-${i + 1}`, $type: 'blob', $source: 'pim', data: 'x'.repeat(12 * 1024 * 1024) }));

describe('EnterspeedContextGraph node', () => {
	it('accepts only the Context Graph credential, never the Core one', () => {
		expect(node.description.credentials).toEqual([
			{ name: 'enterspeedContextGraphApi', required: true },
		]);
	});
});

describe('EnterspeedContextGraph — Entity › Push', () => {
	describe('the item is the record', () => {
		it("defaults every field to the record's own $ field", () => {
			const defaults = Object.fromEntries(node.description.properties.map((p) => [p.name, p.default]));
			expect(defaults).toMatchObject({
				entityId: '={{ $json.$id }}',
				entityType: '={{ $json.$type }}',
				source: '={{ $json.$source }}',
				action: '={{ $json.$action }}',
				modifiedAt: '={{ $json.$modifiedAt }}',
			});
		});

		it('has no way to reshape the record and no batch setting', () => {
			const names = node.description.properties.map((p) => p.name);
			expect(names).not.toContain('propertiesMode');
			expect(names).not.toContain('propertiesJson');
			expect(names).not.toContain('delete');
			expect(names).not.toContain('options');
		});

		it('sends records that are already Context Graph records exactly as they are', async () => {
			const stamped = { ...navPricing, $modifiedAt: '2026-06-01T09:00:00Z' };
			const items: IDataObject[] = [pimCategory, stamped];
			const { httpRequest } = await push({ items });
			const req = httpRequest.mock.calls[0][0] as IDataObject;
			expect(req.body).toBe(items.map((i) => JSON.stringify(i)).join('\n') + '\n');
		});

		it('sends to {ingestUrl}/entities as NDJSON with the API key header', async () => {
			const { httpRequest } = await push({});
			const req = httpRequest.mock.calls[0][0] as IDataObject;
			expect(req.method).toBe('POST');
			// the trailing slash on the credential's Ingest URL is trimmed
			expect(req.url).toBe('http://localhost:5200/entities');
			expect(req.headers).toEqual({ 'Content-Type': 'application/x-ndjson', 'X-Api-Key': 'cg-key' });
		});

		it('sets a $ field the developer maps, keeping every other field', async () => {
			const { httpRequest } = await push({
				items: [{ recordKey: 'k-1', name: 'Chair' }],
				params: { entityId: 'k-1', entityType: 'product', source: 'commerce' },
			});
			expect(sent(httpRequest)).toEqual([
				{ recordKey: 'k-1', name: 'Chair', $id: 'k-1', $type: 'product', $source: 'commerce' },
			]);
		});

		it("lets a mapped value win over the record's own", async () => {
			const { httpRequest } = await push({ params: { source: 'pim-eu' } });
			expect(sent(httpRequest)[0]).toEqual({ ...pimCategory, $source: 'pim-eu' });
		});
	});

	describe('$id and $type (Ingest NDJSON contract: required, non-blank strings, kept as sent)', () => {
		it('sends the ID exactly as given, without trimming it', async () => {
			const { httpRequest } = await push({ params: { entityId: ' p1 ' } });
			expect(sent(httpRequest)[0].$id).toBe(' p1 ');
		});

		it('reports a missing or blank ID or type per item, without sending it, and still pushes the rest', async () => {
			const items: IDataObject[] = [pimCategory, { name: 'no key' }, { ...navPricing, $type: '  ' }];
			const { httpRequest, out } = await push({ items });
			expect(sent(httpRequest).map((l) => l.$id)).toEqual(['pim-cat-dd34d4']);
			expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
			expect(out[1].json).toMatchObject({ accepted: false, error: 'Item 1 is missing Entity ID and is missing Entity Type.' });
			expect(out[2].json).toMatchObject({ accepted: false, error: 'Item 2 is missing Entity Type.' });
		});

		it('reports an ID that is not text instead of converting it', async () => {
			const { httpRequest, out } = await push({ items: [{ ...pimCategory, $id: 42 }] });
			expect(httpRequest).not.toHaveBeenCalled();
			expect(out[0].json).toMatchObject({ accepted: false, error: 'Item 0 has Entity ID that is not text.' });
		});
	});

	describe('$source (optional: derived from the API key when absent, ADR-005)', () => {
		it('leaves $source out when the record has none', async () => {
			const { httpRequest, out } = await push({ items: [{ $id: 'k-1', $type: 'product', name: 'Chair' }] });
			expect(sent(httpRequest)).toEqual([{ $id: 'k-1', $type: 'product', name: 'Chair' }]);
			expect(out[0].json).not.toHaveProperty('source');
		});

		it("reports the service's per-record rejection of a missing source", async () => {
			const httpRequest = vi.fn(async () => [
				{ id: 'k-1', accepted: false, error: "Missing required '$source' field.", statusCode: 403 },
			]);
			const { out } = await push({ items: [{ $id: 'k-1', $type: 'product' }], httpRequest });
			expect(out[0].json).toMatchObject({ accepted: false, statusCode: 403, error: "Missing required '$source' field." });
		});
	});

	describe('$action (delete in any case deletes; anything else saves)', () => {
		it("deletes a record whose own $action is delete, sending no other fields", async () => {
			const { httpRequest, out } = await push({ items: [{ ...pimDelete, name: 'ignored' }] });
			expect(sent(httpRequest)).toEqual([pimDelete]);
			expect(out[0].json.action).toBe('delete');
		});

		it('matches delete in any letter case', async () => {
			const { httpRequest } = await push({ items: [{ ...pimDelete, $action: 'DELETE' }] });
			expect(sent(httpRequest)).toEqual([pimDelete]);
		});

		it.each([[null], ['upsert'], ['remove']])('saves when $action is %s, without sending $action', async (value) => {
			const { httpRequest, out } = await push({ items: [{ ...pimCategory, $action: value }] });
			expect(sent(httpRequest)).toEqual([pimCategory]);
			expect(out[0].json.action).toBe('upsert');
		});

		it('deletes from a mapped Action, e.g. a deleted flag in the data', async () => {
			const items: IDataObject[] = [pimCategory, { ...navPricing, deleted: true }];
			const { httpRequest } = await push({
				items,
				params: { action: (i: number) => (items[i].deleted ? 'delete' : '') },
			});
			expect(sent(httpRequest)).toEqual([
				pimCategory,
				{ $id: 'nav-prc-541690', $type: 'pricing', $source: 'nav', $action: 'delete' },
			]);
		});
	});

	describe('$modifiedAt (ingest/ADR-013 sender clock)', () => {
		it("passes the record's own stamp through on a save and on a delete", async () => {
			const items: IDataObject[] = [
				{ ...pimCategory, $modifiedAt: '2026-06-01T09:00:00Z' },
				{ ...pimDelete, $modifiedAt: '2026-06-02T10:00:00+02:00' },
			];
			const { httpRequest } = await push({ items });
			expect(sent(httpRequest)).toEqual(items);
		});

		it('stamps from a mapped field, sent as resolved', async () => {
			const { httpRequest } = await push({
				items: [{ ...pimCategory, updatedAt: '2026-06-01T09:00:00Z' }],
				params: { modifiedAt: '2026-06-01T09:00:00Z' },
			});
			expect(sent(httpRequest)[0].$modifiedAt).toBe('2026-06-01T09:00:00Z');
		});

		it('sends no stamp when none is given', async () => {
			const { httpRequest } = await push({});
			expect(sent(httpRequest)[0]).not.toHaveProperty('$modifiedAt');
		});
	});

	describe('results (Ingest bulk-result contract)', () => {
		it('outputs one result per item, paired to its input', async () => {
			const { out } = await push({ items: [pimCategory, pimDelete] });
			expect(out).toEqual([
				{
					json: { id: 'pim-cat-dd34d4', type: 'category', source: 'pim', action: 'upsert', accepted: true, statusCode: 200 },
					pairedItem: { item: 0 },
				},
				{
					json: { id: 'pim-prd-2005f2', type: 'product', source: 'pim', action: 'delete', accepted: true, statusCode: 200 },
					pairedItem: { item: 1 },
				},
			]);
		});

		it('reports records the service rejected (207) without dropping the accepted ones', async () => {
			const httpRequest = vi.fn(async () => [
				{ id: 'pim-cat-dd34d4', accepted: true, statusCode: 200 },
				{ id: 'nav-prc-541690', accepted: false, error: 'Write failed.', statusCode: 500 },
			]);
			const { out } = await push({ items: [pimCategory, navPricing], httpRequest });
			expect(out.map((o) => o.json.accepted)).toEqual([true, false]);
			expect(out[1].json).toMatchObject({ statusCode: 500, error: 'Write failed.' });
		});

		it('parses a response that arrives as a string', async () => {
			const httpRequest = vi.fn(async () => JSON.stringify([{ id: 'pim-cat-dd34d4', accepted: true, statusCode: 200 }]));
			const { out } = await push({ httpRequest });
			expect(out[0].json.accepted).toBe(true);
		});

		it('fails when the service answers a different number of results than lines sent', async () => {
			const httpRequest = vi.fn(async () => [{ id: 'pim-cat-dd34d4', accepted: true }]);
			await expect(push({ items: [pimCategory, navPricing], httpRequest })).rejects.toThrow(
				'Expected 2 results from the Ingest URL but got 1',
			);
		});
	});

	describe('request size (ingest/ADR-020 D5: 32 MiB body limit; Push is not the bulk path)', () => {
		it('sends a whole run in one request when it fits, whatever the number of records', async () => {
			const items = Array.from({ length: 1201 }, (_, i) => ({ ...pimCategory, $id: `pim-cat-${i}` }));
			const { httpRequest, out } = await push({ items });
			expect(httpRequest).toHaveBeenCalledTimes(1);
			expect(out).toHaveLength(1201);
		});

		it('starts a new request before one would go over the limit, keeping output in input order', async () => {
			const { httpRequest, out } = await push({ items: big(3) });
			expect(httpRequest.mock.calls.map((c) => ndjsonLines(c[0] as IDataObject).length)).toEqual([2, 1]);
			for (const call of httpRequest.mock.calls) {
				expect(new TextEncoder().encode((call[0] as IDataObject).body as string).length).toBeLessThanOrEqual(
					MAX_REQUEST_BYTES,
				);
			}
			expect(out.map((o) => o.json.id)).toEqual(['big-1', 'big-2', 'big-3']);
		});

		it('reports a single record over the limit without sending it, and still pushes the rest', async () => {
			const { httpRequest, out } = await push({
				items: [pimCategory, { ...navPricing, huge: 'x'.repeat(MAX_REQUEST_BYTES) }],
			});
			expect(sent(httpRequest).map((l) => l.$id)).toEqual(['pim-cat-dd34d4']);
			expect(out[1].json).toMatchObject({
				accepted: false,
				error: 'Item 1 is larger than the Ingest URL accepts in one request.',
			});
		});
	});

	describe('failed requests', () => {
		it.each([
			[401, 'The API key was rejected by the Ingest URL.'],
			[403, "The API key isn't allowed to write to this Context Graph."],
			[413, 'The Ingest URL refused the request as too large.'],
			[429, 'The Ingest URL is still throttling requests after retrying. Try again later.'],
			[500, 'The Ingest URL answered with status 500.'],
		])('fails with a clear message when the service answers %i', async (status, message) => {
			const httpRequest = vi.fn(async () => {
				throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
			});
			await expect(push({ httpRequest })).rejects.toThrow(message);
		});

		it('fails with a clear message when the Ingest URL cannot be reached', async () => {
			const httpRequest = vi.fn(async () => {
				throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
			});
			await expect(push({ httpRequest })).rejects.toThrow("Couldn't reach the Ingest URL (http://localhost:5200).");
		});

		it('does not put record content or the API key in the error', async () => {
			const httpRequest = vi.fn(async () => {
				throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
			});
			const error = await push({ items: [{ ...pimCategory, secretField: 'record-content' }], httpRequest }).catch(
				(e: Error) => e,
			);
			expect(String((error as Error).message)).not.toContain('record-content');
			expect(String((error as Error).message)).not.toContain('cg-key');
		});

		it('with Continue On Fail, reports a failed request per item, with its description, and sends the next', async () => {
			const httpRequest = vi
				.fn()
				.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
				.mockImplementationOnce(async (req: IDataObject) =>
					ndjsonLines(req).map((l) => ({ id: l.$id, accepted: true, statusCode: 200 })),
				);
			const { out } = await push({ items: big(3), httpRequest, continueOnFail: true });
			expect(out.map((o) => o.json.accepted)).toEqual([false, false, true]);
			expect(out[0].json).toMatchObject({
				error: "Couldn't reach the Ingest URL (http://localhost:5200).",
				description: 'connect ECONNREFUSED',
			});
		});

		it('with Continue On Fail, reports a result-count mismatch per item and sends the next request', async () => {
			const httpRequest = vi
				.fn()
				.mockResolvedValueOnce([{ id: 'big-1', accepted: true }])
				.mockImplementationOnce(async (req: IDataObject) =>
					ndjsonLines(req).map((l) => ({ id: l.$id, accepted: true, statusCode: 200 })),
				);
			const { out } = await push({ items: big(3), httpRequest, continueOnFail: true });
			expect(out.map((o) => o.json.accepted)).toEqual([false, false, true]);
			expect(out[0].json.error).toBe('Expected 2 results from the Ingest URL but got 1');
		});
	});

	describe('throttling (429, ingest/ADR-020 D3: retry with the given delay)', () => {
		const throttled = (retryAfter?: string) =>
			Object.assign(new Error('Too Many Requests'), {
				response: { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
			});
		const accept = async (req: IDataObject) =>
			ndjsonLines(req).map((l) => ({ id: l.$id, accepted: true, statusCode: 200 }));

		it('waits the Retry-After and resends only the refused request', async () => {
			sleep.mockClear();
			const httpRequest = vi
				.fn()
				.mockImplementationOnce(accept)
				.mockRejectedValueOnce(throttled('2'))
				.mockImplementation(accept);
			const { out } = await push({ items: big(3), httpRequest });
			expect(sleep).toHaveBeenCalledWith(2000);
			expect(httpRequest.mock.calls.map((c) => ndjsonLines(c[0] as IDataObject).map((l) => l.$id))).toEqual([
				['big-1', 'big-2'],
				['big-3'],
				['big-3'],
			]);
			expect(out.map((o) => o.json.accepted)).toEqual([true, true, true]);
		});

		it('reads a Retry-After given as an HTTP date', async () => {
			sleep.mockClear();
			const httpRequest = vi
				.fn()
				.mockRejectedValueOnce(throttled(new Date(Date.now() + 5000).toUTCString()))
				.mockImplementation(accept);
			await push({ httpRequest });
			const waited = sleep.mock.calls[0][0];
			expect(waited).toBeGreaterThan(3000);
			expect(waited).toBeLessThanOrEqual(5000);
		});

		it(`gives up after ${MAX_THROTTLE_RETRIES} retries`, async () => {
			const httpRequest = vi.fn(async () => {
				throw throttled('1');
			});
			await expect(push({ httpRequest })).rejects.toThrow('still throttling requests after retrying');
			expect(httpRequest).toHaveBeenCalledTimes(MAX_THROTTLE_RETRIES + 1);
		});

		it('does not hold the run open for a Retry-After longer than five minutes', async () => {
			const httpRequest = vi.fn(async () => {
				throw throttled('3600');
			});
			await expect(push({ httpRequest })).rejects.toThrow('still throttling requests after retrying');
			expect(httpRequest).toHaveBeenCalledTimes(1);
		});

		it('does not retry other failures', async () => {
			const httpRequest = vi.fn(async () => {
				throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
			});
			await expect(push({ httpRequest })).rejects.toThrow();
			expect(httpRequest).toHaveBeenCalledTimes(1);
		});
	});
});

describe('EnterspeedContextGraphApi credential', () => {
	const field = (name: string) => credential.properties.find((p) => p.name === name);

	it('has an ingest URL, a delivery URL, a manifest version and an API key', () => {
		expect(credential.properties.map((p) => p.name).sort()).toEqual(
			['apiKey', 'deliveryUrl', 'ingestUrl', 'manifestVersion'].sort(),
		);
	});

	it('masks the API key', () => {
		expect(field('apiKey')?.typeOptions?.password).toBe(true);
	});

	it('sends the API key only as the X-Api-Key header', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { 'X-Api-Key': '={{$credentials.apiKey}}' } },
		});
	});

	it('tests against the read-only manifest document on the Delivery URL', () => {
		expect(credential.test.request.baseURL).toContain('$credentials.deliveryUrl');
		expect(credential.test.request.url).toBe('=/schema/msd/v1/{{$credentials.manifestVersion}}');
		expect(credential.test.request.method ?? 'GET').toBe('GET');
	});

	it('gives a clear message for a rejected key and an unknown manifest version', () => {
		const codes = (credential.test.rules ?? []).map((r) => r.type === 'responseCode' && r.properties.value);
		expect(codes).toEqual([401, 404]);
	});

	it('does not reuse the Core credential name', () => {
		expect(credential.name).not.toBe('enterspeedApi');
	});
});
