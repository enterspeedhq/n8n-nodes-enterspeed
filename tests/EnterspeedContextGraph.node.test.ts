import { describe, it, expect, vi } from 'vitest';
import type { IDataObject, INode, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { EnterspeedContextGraph } from '../nodes/EnterspeedContextGraph/EnterspeedContextGraph.node';
import {
	MAX_REQUEST_BYTES,
	MAX_THROTTLE_RETRIES,
} from '../nodes/EnterspeedContextGraph/actions/entity/shared';
import { MAX_BODY_BYTES } from '../nodes/EnterspeedContextGraph/actions/shape/getMany.operation';
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
 * (one NDJSON line, per the Context Graph's Ingest NDJSON contract), one
 * request per item, and outputs one result per item. Push Many sends a list
 * of records held in one item in one request, and outputs one result per
 * record. The service answers a per-line
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

/** Every line sent, across all requests, in order. */
const allSent = (httpRequest: ReturnType<typeof vi.fn>) =>
	httpRequest.mock.calls.flatMap((c) => ndjsonLines(c[0] as IDataObject));

/** The $id of each line, one array per request. */
const perRequest = (httpRequest: ReturnType<typeof vi.fn>) =>
	httpRequest.mock.calls.map((c) => ndjsonLines(c[0] as IDataObject).map((l) => l.$id));

/**
 * A failure as n8n hands it to the node: a NodeApiError, with the HTTP
 * error (status and headers) as its `cause`.
 */
const httpNode = { id: '1', name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [0, 0], parameters: {} } as INode;
const n8nFailure = (status: number, headers: IDataObject = {}) =>
	Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), { cause: { response: { status, headers } } });

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
			expect(httpRequest.mock.calls.map((c) => (c[0] as IDataObject).body)).toEqual(
				items.map((i) => JSON.stringify(i) + '\n'),
			);
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
			expect(allSent(httpRequest)).toEqual([
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
			expect(allSent(httpRequest)).toEqual(items);
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

		it('reports records the service rejected without dropping the accepted ones', async () => {
			const httpRequest = vi
				.fn()
				.mockResolvedValueOnce([{ id: 'pim-cat-dd34d4', accepted: true, statusCode: 200 }])
				.mockResolvedValueOnce([{ id: 'nav-prc-541690', accepted: false, error: 'Write failed.', statusCode: 500 }]);
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
			const httpRequest = vi.fn(async () => []);
			await expect(push({ httpRequest })).rejects.toThrow('Expected 1 results from the Ingest URL but got 0');
		});
	});

	describe('one request per item', () => {
		it('sends each item in its own request, keeping output in input order', async () => {
			const { httpRequest, out } = await push({ items: [pimCategory, navPricing, pimDelete] });
			expect(perRequest(httpRequest)).toEqual([['pim-cat-dd34d4'], ['nav-prc-541690'], ['pim-prd-2005f2']]);
			expect(out.map((o) => o.json.id)).toEqual(['pim-cat-dd34d4', 'nav-prc-541690', 'pim-prd-2005f2']);
		});

		it('reports a record over the 32 MiB request limit (ingest/ADR-020 D5) without sending it, and still pushes the rest', async () => {
			const { httpRequest, out } = await push({
				items: [pimCategory, { ...navPricing, huge: 'x'.repeat(MAX_REQUEST_BYTES) }],
			});
			expect(allSent(httpRequest).map((l) => l.$id)).toEqual(['pim-cat-dd34d4']);
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

		it.each([
			[401, 'The API key was rejected by the Ingest URL.'],
			[403, "The API key isn't allowed to write to this Context Graph."],
		])('keeps its own message for %i when n8n hands the failure over as a NodeApiError', async (status, message) => {
			const httpRequest = vi.fn(async () => {
				throw n8nFailure(status);
			});
			const error = (await push({ httpRequest }).catch((e: Error) => e)) as NodeApiError;
			expect(error.message).toBe(message);
			expect(error.httpCode).toBe(String(status));
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
			const { out } = await push({ items: [pimCategory, navPricing], httpRequest, continueOnFail: true });
			expect(out.map((o) => o.json.accepted)).toEqual([false, true]);
			expect(out[0].json).toMatchObject({
				error: "Couldn't reach the Ingest URL (http://localhost:5200).",
				description: 'connect ECONNREFUSED',
			});
		});

		it('with Continue On Fail, reports a result-count mismatch per item and sends the next request', async () => {
			const httpRequest = vi
				.fn()
				.mockResolvedValueOnce([])
				.mockImplementationOnce(async (req: IDataObject) =>
					ndjsonLines(req).map((l) => ({ id: l.$id, accepted: true, statusCode: 200 })),
				);
			const { out } = await push({ items: [pimCategory, navPricing], httpRequest, continueOnFail: true });
			expect(out.map((o) => o.json.accepted)).toEqual([false, true]);
			expect(out[0].json.error).toBe('Expected 1 results from the Ingest URL but got 0');
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
			const { out } = await push({ items: [pimCategory, navPricing, pimDelete], httpRequest });
			expect(sleep).toHaveBeenCalledWith(2000);
			expect(perRequest(httpRequest)).toEqual([
				['pim-cat-dd34d4'],
				['nav-prc-541690'],
				['nav-prc-541690'],
				['pim-prd-2005f2'],
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

		it('reads the Retry-After when n8n hands the 429 over as a NodeApiError', async () => {
			sleep.mockClear();
			const httpRequest = vi
				.fn()
				.mockRejectedValueOnce(n8nFailure(429, { 'retry-after': '7' }))
				.mockImplementation(accept);
			await push({ httpRequest });
			expect(sleep).toHaveBeenCalledWith(7000);
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

describe('EnterspeedContextGraph — Entity › Push Many', () => {
	async function pushMany(opts: {
		records?: unknown | ((i: number) => unknown);
		items?: IDataObject[];
		httpRequest?: ReturnType<typeof vi.fn>;
		continueOnFail?: boolean;
	}) {
		const httpRequest = opts.httpRequest ?? acceptAll();
		const ctx = createContextGraphExecuteMock({
			params: {
				resource: 'entity',
				operation: 'pushMany',
				// What the Records field's default ({{ $json.data }}) resolves to.
				records: opts.records ?? [pimCategory, navPricing, pimDelete],
			},
			items: opts.items ?? [{}],
			httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return { out, httpRequest };
	}

	it('defaults Records to the data field an Aggregate node collects records into', () => {
		const records = node.description.properties.find((p) => p.name === 'records');
		expect(records?.default).toBe('={{ $json.data }}');
	});

	it("has no $ field settings: each record keeps its own", () => {
		const shown = node.description.properties.filter((p) =>
			(p.displayOptions?.show?.operation as string[] | undefined)?.includes('pushMany'),
		);
		expect(shown.map((p) => p.name)).toEqual(['records']);
	});

	it('sends the whole list in one request, each record exactly as it is', async () => {
		const { httpRequest } = await pushMany({});
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toBe(
			[pimCategory, navPricing, pimDelete].map((r) => JSON.stringify(r)).join('\n') + '\n',
		);
	});

	it('outputs one result per record, in list order, paired to the item the list came from', async () => {
		const { out } = await pushMany({});
		expect(out.map((o) => [o.json.id, o.json.action, o.json.accepted, o.pairedItem])).toEqual([
			['pim-cat-dd34d4', 'upsert', true, { item: 0 }],
			['nav-prc-541690', 'upsert', true, { item: 0 }],
			['pim-prd-2005f2', 'delete', true, { item: 0 }],
		]);
	});

	it('sends each item’s list in its own request', async () => {
		const lists = [[pimCategory], [navPricing, pimDelete]];
		const { httpRequest, out } = await pushMany({ items: [{}, {}], records: (i: number) => lists[i] });
		expect(perRequest(httpRequest)).toEqual([['pim-cat-dd34d4'], ['nav-prc-541690', 'pim-prd-2005f2']]);
		expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 1 }]);
	});

	it('accepts the list typed in as JSON text', async () => {
		const { httpRequest } = await pushMany({ records: JSON.stringify([pimCategory]) });
		expect(sent(httpRequest)).toEqual([pimCategory]);
	});

	it('reports a record without a text $id or $type, or that is not an object, without sending it', async () => {
		const { httpRequest, out } = await pushMany({
			records: [pimCategory, { name: 'no key' }, { ...navPricing, $id: 42 }, 'text'],
		});
		expect(sent(httpRequest)).toEqual([pimCategory]);
		expect(out.map((o) => o.json.error)).toEqual([
			undefined,
			'Item 0, record 1 is missing Entity ID and is missing Entity Type.',
			'Item 0, record 2 has Entity ID that is not text.',
			'Item 0, record 3 is not an object.',
		]);
	});

	it('sends nothing for an empty list', async () => {
		const { httpRequest, out } = await pushMany({ records: [] });
		expect(httpRequest).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it('fails when Records is not a list, or with Continue On Fail reports it on the item', async () => {
		await expect(pushMany({ records: pimCategory })).rejects.toThrow('Item 0 has Records that are not a list.');
		const { out } = await pushMany({ records: 'not json', continueOnFail: true });
		expect(out).toEqual([
			{ json: { accepted: false, error: 'Item 0 has Records that are not a list.' }, pairedItem: { item: 0 } },
		]);
	});

	it('splits a list only before the 32 MiB request limit (ingest/ADR-020 D5)', async () => {
		const { httpRequest, out } = await pushMany({ records: big(3) });
		expect(perRequest(httpRequest)).toEqual([['big-1', 'big-2'], ['big-3']]);
		for (const call of httpRequest.mock.calls) {
			expect(new TextEncoder().encode((call[0] as IDataObject).body as string).length).toBeLessThanOrEqual(
				MAX_REQUEST_BYTES,
			);
		}
		expect(out.map((o) => o.json.id)).toEqual(['big-1', 'big-2', 'big-3']);
	});

	it('with Continue On Fail, reports a failed request on each of its records', async () => {
		const httpRequest = vi.fn(async () => {
			throw n8nFailure(401);
		});
		const { out } = await pushMany({ httpRequest, continueOnFail: true });
		expect(out.map((o) => [o.json.accepted, o.json.error])).toEqual([
			[false, 'The API key was rejected by the Ingest URL.'],
			[false, 'The API key was rejected by the Ingest URL.'],
			[false, 'The API key was rejected by the Ingest URL.'],
		]);
	});
});

/**
 * Shape › Get reads one shape per item with `GET {deliveryUrl}/shapes/v1/{manifest}/{key}`;
 * Shape › Get Many reads one item's list of keys in one `POST {deliveryUrl}/shapes/v1/{manifest}`,
 * answered 207 with one `{ key, status, data }` per key (Shapes batch envelope).
 * Shapes from the Tonevik example's stage 1 schema.
 */

const speakers = { name: 'Speakers' };
const p1001 = { name: 'Aurora H100 Over-Ear Headphones', categoryId: 'cat-headphones', price: 2700 };
const categoryKeys = ['CategoryRef:categoryId:cat-audio', 'CategoryRef:categoryId:cat-speakers'];

/** A failed request as the tests' mock throws it: the HTTP error itself. */
const httpError = (status: number, data?: unknown) =>
	Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

/** A failed request as n8n's request helper throws it: wrapped in a NodeApiError. */
const n8nError = (status: number, data?: unknown) =>
	new NodeApiError({ name: 'Enterspeed Context Graph' } as INode, httpError(status, data) as unknown as JsonObject);

/**
 * Get gets one key per item; Get Many gets all the keys as one
 * list in one item (what its Shape Keys default, {{ $json.keys }}, resolves to).
 */
async function readShapes(opts: {
	operation: 'get' | 'getMany';
	keys: unknown;
	httpRequest: ReturnType<typeof vi.fn>;
	continueOnFail?: boolean;
}) {
	const keys = opts.keys as unknown[];
	const ctx = createContextGraphExecuteMock({
		params:
			opts.operation === 'get'
				? { resource: 'shape', operation: 'get', shapeKey: (i: number) => keys[i] }
				: { resource: 'shape', operation: 'getMany', shapeKeys: opts.keys },
		items: opts.operation === 'get' ? keys.map(() => ({})) : [{}],
		httpRequest: opts.httpRequest,
		continueOnFail: opts.continueOnFail,
	});
	const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
	return out;
}

/** Answers a batch with the given item per key, in request order. */
const batchOf = (answer: (key: string) => IDataObject) =>
	vi.fn(async (req: IDataObject) => ((req.body as IDataObject).keys as string[]).map(answer));

describe('EnterspeedContextGraph — Shape', () => {
	it('has Get (a Shape Key per item) and Get Many (a list of Shape Keys in one item)', () => {
		const shapeFields = node.description.properties.filter((p) =>
			(p.displayOptions?.show?.resource as string[] | undefined)?.includes('shape'),
		);
		const selector = shapeFields.find((p) => p.name === 'operation');
		expect(selector?.options?.map((o) => (o as { name: string }).name)).toEqual(['Get', 'Get Many']);
		expect(selector?.options?.map((o) => (o as { value: string }).value)).toEqual(['get', 'getMany']);
		const field = (name: string) => shapeFields.find((p) => p.name === name);
		expect(shapeFields.filter((p) => p.name !== 'operation').map((p) => p.name)).toEqual(['shapeKey', 'shapeKeys']);
		expect(field('shapeKey')?.displayOptions?.show?.operation).toEqual(['get']);
		expect(field('shapeKeys')?.displayOptions?.show?.operation).toEqual(['getMany']);
		expect(field('shapeKeys')?.default).toBe('={{ $json.keys }}');
	});
});

describe('EnterspeedContextGraph — Shape › Get', () => {
	it('reads {deliveryUrl}/shapes/v1/{manifest}/{key as path segments} with the API key', async () => {
		const httpRequest = vi.fn(async () => speakers);
		await readShapes({ operation: 'get', keys: ['CategoryRef:categoryId:cat-speakers'], httpRequest });
		const req = httpRequest.mock.calls[0][0] as IDataObject;
		expect(req.method).toBe('GET');
		expect(req.url).toBe('http://localhost:5200/shapes/v1/1.0.0/CategoryRef/categoryId/cat-speakers');
		expect((req.headers as IDataObject)['X-Api-Key']).toBe('cg-key');
	});

	it('outputs the shape exactly as delivered, paired to its item', async () => {
		const out = await readShapes({
			operation: 'get',
			keys: ['ProductCard:productId:p-1001'],
			httpRequest: vi.fn(async () => p1001),
		});
		expect(out).toEqual([{ json: p1001, pairedItem: { item: 0 } }]);
	});

	it('sends one request per item and keeps the output in item order', async () => {
		const httpRequest = vi.fn(async (req: IDataObject) => ({ name: String(req.url).split('/').pop() }));
		const out = await readShapes({ operation: 'get', keys: categoryKeys, httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(out.map((o) => o.json.name)).toEqual(['cat-audio', 'cat-speakers']);
		expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('percent-encodes each segment, so values with URL characters reach the service verbatim', async () => {
		const httpRequest = vi.fn(async () => ({}));
		await readShapes({ operation: 'get', keys: ['Card:sku:a=b c%d?e&f#g~h'], httpRequest });
		expect((httpRequest.mock.calls[0][0] as IDataObject).url).toBe(
			'http://localhost:5200/shapes/v1/1.0.0/Card/sku/a%3Db%20c%25d%3Fe%26f%23g~h',
		);
	});

	it('parses a shape that arrives as a string', async () => {
		const out = await readShapes({
			operation: 'get',
			keys: ['CategoryRef:categoryId:cat-speakers'],
			httpRequest: vi.fn(async () => JSON.stringify(speakers)),
		});
		expect(out[0].json).toEqual(speakers);
	});

	describe('a key with no shape (404)', () => {
		it('fails with a not-found error naming the key', async () => {
			const httpRequest = vi.fn(async () => {
				throw httpError(404);
			});
			await expect(
				readShapes({ operation: 'get', keys: ['ProductCard:productId:p-1010'], httpRequest }),
			).rejects.toThrow('No shape for key "ProductCard:productId:p-1010".');
		});

		it('fails the same way when n8n hands the failure over wrapped', async () => {
			const httpRequest = vi.fn(async () => {
				throw n8nError(404);
			});
			const error = await readShapes({ operation: 'get', keys: ['ProductCard:productId:p-1010'], httpRequest }).catch(
				(e: NodeApiError) => e,
			);
			expect((error as NodeApiError).message).toBe('No shape for key "ProductCard:productId:p-1010".');
			expect((error as NodeApiError).httpCode).toBe('404');
		});

		it('with Continue On Fail, outputs an error item and still reads the other keys', async () => {
			const httpRequest = vi
				.fn()
				.mockRejectedValueOnce(httpError(404))
				.mockResolvedValueOnce(p1001);
			const out = await readShapes({
				operation: 'get',
				keys: ['ProductCard:productId:p-1010', 'ProductCard:productId:p-1001'],
				httpRequest,
				continueOnFail: true,
			});
			expect(out).toEqual([
				{
					json: { key: 'ProductCard:productId:p-1010', error: 'No shape for key "ProductCard:productId:p-1010".' },
					pairedItem: { item: 0 },
				},
				{ json: p1001, pairedItem: { item: 1 } },
			]);
		});
	});

	describe("a malformed key (400): the service's own message", () => {
		it('from the dev-server ({ error, message })', async () => {
			const httpRequest = vi.fn(async () => {
				throw n8nError(400, { error: 'invalid_key', message: 'Shape "Nope" is not in the manifest.' });
			});
			await expect(readShapes({ operation: 'get', keys: ['Nope:id:1'], httpRequest })).rejects.toThrow(
				'Shape "Nope" is not in the manifest.',
			);
		});

		it('from the deployed service (a bare JSON string)', async () => {
			const httpRequest = vi.fn(async () => {
				throw httpError(400, '"Missing shape key"');
			});
			await expect(readShapes({ operation: 'get', keys: [':'], httpRequest })).rejects.toThrow('Missing shape key');
		});
	});

	it("uses the service's message for a 404 that has one, e.g. an unknown manifest version", async () => {
		const message = 'No manifest "2.0.0" — this dev server hosts v1.0.0.';
		const httpRequest = vi.fn(async () => {
			throw httpError(404, { error: 'not_found', message });
		});
		await expect(readShapes({ operation: 'get', keys: ['CategoryRef:categoryId:x'], httpRequest })).rejects.toThrow(
			message,
		);
	});

	it('reports a missing, blank or non-text key without sending it', async () => {
		const httpRequest = vi.fn(async () => speakers);
		const out = await readShapes({ operation: 'get', keys: [undefined, '  ', 42], httpRequest, continueOnFail: true });
		expect(httpRequest).not.toHaveBeenCalled();
		expect(out.map((o) => o.json.error)).toEqual([
			'Item 0 has no Shape Key.',
			'Item 1 has no Shape Key.',
			'Item 2 has a Shape Key that is not text.',
		]);
	});

	it('gives clear messages for a rejected key, a retired API version and an unreachable URL, without the key', async () => {
		const fails = (error: unknown) =>
			readShapes({
				operation: 'get',
				keys: ['CategoryRef:categoryId:cat-speakers'],
				httpRequest: vi.fn(async () => {
					throw error;
				}),
			}).catch((e: Error) => e.message);
		expect(await fails(n8nError(401))).toBe('The API key was rejected by the Delivery URL.');
		expect(await fails(httpError(410))).toBe("The Delivery URL no longer serves API version v1.");
		expect(await fails(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
			"Couldn't reach the Delivery URL (http://localhost:5200).",
		);
		expect(await fails(httpError(500))).toBe('The Delivery URL answered with status 500.');
		expect(await fails(n8nError(401))).not.toContain('cg-key');
	});
});

describe('EnterspeedContextGraph — Shape › Get Many', () => {
	it('sends the list of keys in one POST to {deliveryUrl}/shapes/v1/{manifest}, in list order', async () => {
		const httpRequest = batchOf((key) => ({ key, status: 200, data: speakers }));
		await readShapes({ operation: 'getMany', keys: categoryKeys, httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(1);
		const req = httpRequest.mock.calls[0][0] as IDataObject;
		expect(req.method).toBe('POST');
		expect(req.url).toBe('http://localhost:5200/shapes/v1/1.0.0');
		expect(req.body).toEqual({ keys: categoryKeys });
		expect((req.headers as IDataObject)['X-Api-Key']).toBe('cg-key');
	});

	it('outputs each { key, status, data } exactly as delivered, in list order, paired to the item the list came from', async () => {
		const out = await readShapes({
			operation: 'getMany',
			keys: categoryKeys,
			httpRequest: batchOf((key) => ({ key, status: 200, data: { name: key.split(':').pop() } })),
		});
		expect(out).toEqual([
			{ json: { key: categoryKeys[0], status: 200, data: { name: 'cat-audio' } }, pairedItem: { item: 0 } },
			{ json: { key: categoryKeys[1], status: 200, data: { name: 'cat-speakers' } }, pairedItem: { item: 0 } },
		]);
	});

	it("sends each item's list in its own request", async () => {
		const lists = [[categoryKeys[0]], [categoryKeys[1], 'ProductCard:productId:p-1001']];
		const httpRequest = batchOf((key) => ({ key, status: 200, data: {} }));
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'shape', operation: 'getMany', shapeKeys: (i: number) => lists[i] },
			items: [{}, {}],
			httpRequest,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		expect(httpRequest.mock.calls.map((c) => ((c[0] as IDataObject).body as IDataObject).keys)).toEqual(lists);
		expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }, { item: 1 }]);
	});

	it('accepts the list typed in as JSON text', async () => {
		const httpRequest = batchOf((key) => ({ key, status: 200, data: speakers }));
		await readShapes({ operation: 'getMany', keys: JSON.stringify(categoryKeys), httpRequest });
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toEqual({ keys: categoryKeys });
	});

	it('fails when Shape Keys is not a list, or with Continue On Fail reports it on the item', async () => {
		const httpRequest = vi.fn();
		await expect(readShapes({ operation: 'getMany', keys: categoryKeys[0], httpRequest })).rejects.toThrow(
			'Item 0 has Shape Keys that are not a list.',
		);
		const out = await readShapes({ operation: 'getMany', keys: { keys: [] }, httpRequest, continueOnFail: true });
		expect(out).toEqual([{ json: { error: 'Item 0 has Shape Keys that are not a list.' }, pairedItem: { item: 0 } }]);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('outputs a key with no shape as a 404 item with data null, and still returns the others', async () => {
		const out = await readShapes({
			operation: 'getMany',
			keys: ['ProductCard:productId:p-1010', 'ProductCard:productId:p-1001'],
			httpRequest: batchOf((key) =>
				key.endsWith('p-1010') ? { key, status: 404, data: null } : { key, status: 200, data: p1001 },
			),
		});
		expect(out.map((o) => o.json)).toEqual([
			{ key: 'ProductCard:productId:p-1010', status: 404, data: null },
			{ key: 'ProductCard:productId:p-1001', status: 200, data: p1001 },
		]);
	});

	it("passes the dev-server's other per-key statuses (400, 500) through unchanged", async () => {
		const out = await readShapes({
			operation: 'getMany',
			keys: ['Nope:id:1', 'CategoryRef:categoryId:cat-audio'],
			httpRequest: batchOf((key) => ({ key, status: key.startsWith('Nope') ? 400 : 500, data: null })),
		});
		expect(out.map((o) => o.json.status)).toEqual([400, 500]);
	});

	it('parses items that arrive as a string', async () => {
		const out = await readShapes({
			operation: 'getMany',
			keys: [categoryKeys[1]],
			httpRequest: vi.fn(async () => JSON.stringify([{ key: categoryKeys[1], status: 200, data: speakers }])),
		});
		expect(out[0].json).toEqual({ key: categoryKeys[1], status: 200, data: speakers });
	});

	it('sends nothing and outputs nothing for an empty list', async () => {
		const httpRequest = vi.fn();
		expect(await readShapes({ operation: 'getMany', keys: [], httpRequest })).toEqual([]);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('fails on a missing or non-text key without sending anything', async () => {
		const httpRequest = vi.fn();
		await expect(
			readShapes({ operation: 'getMany', keys: [categoryKeys[0], ''], httpRequest }),
		).rejects.toThrow('Item 0, key 1 has no Shape Key.');
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('with Continue On Fail, outputs an error item for a missing key and still sends the others', async () => {
		const httpRequest = batchOf((key) => ({ key, status: 200, data: speakers }));
		const out = await readShapes({
			operation: 'getMany',
			keys: [categoryKeys[0], '', categoryKeys[1]],
			httpRequest,
			continueOnFail: true,
		});
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toEqual({ keys: categoryKeys });
		expect(out.map((o) => [o.pairedItem, o.json.status ?? o.json.error])).toEqual([
			[{ item: 0 }, 200],
			[{ item: 0 }, 'Item 0, key 1 has no Shape Key.'],
			[{ item: 0 }, 200],
		]);
	});

	it('starts a new request before a body would pass the service\'s 32 KiB limit, keeping output in list order', async () => {
		// Each key is ~10 KiB, so two fit in one request and the third starts the next.
		const keys = [1, 2, 3].map((n) => `Card:id:${String(n).repeat(10 * 1024)}`);
		const httpRequest = batchOf((key) => ({ key, status: 200, data: {} }));
		const out = await readShapes({ operation: 'getMany', keys, httpRequest });
		const bodies = httpRequest.mock.calls.map((c) => ((c[0] as IDataObject).body as IDataObject).keys as string[]);
		expect(bodies.map((b) => b.length)).toEqual([2, 1]);
		for (const b of bodies) expect(new TextEncoder().encode(JSON.stringify({ keys: b })).length).toBeLessThan(MAX_BODY_BYTES);
		expect(out.map((o) => o.json.key)).toEqual(keys);
	});

	it('fails when the whole request fails, with the same messages as Get', async () => {
		const httpRequest = vi.fn(async () => {
			throw n8nError(401);
		});
		await expect(readShapes({ operation: 'getMany', keys: categoryKeys, httpRequest })).rejects.toThrow(
			'The API key was rejected by the Delivery URL.',
		);
	});

	it('with Continue On Fail, reports a failed request on each of its keys', async () => {
		const httpRequest = vi.fn(async () => {
			throw n8nError(400, { error: 'invalid_request', message: 'Request body must be { "keys": string[] }.' });
		});
		const out = await readShapes({ operation: 'getMany', keys: categoryKeys, httpRequest, continueOnFail: true });
		expect(out).toEqual(
			categoryKeys.map((key) => ({
				json: { key, error: 'Request body must be { "keys": string[] }.' },
				pairedItem: { item: 0 },
			})),
		);
	});

	it('fails when the service answers a different number of items than keys sent', async () => {
		const httpRequest = vi.fn(async () => [{ key: categoryKeys[0], status: 200, data: speakers }]);
		await expect(readShapes({ operation: 'getMany', keys: categoryKeys, httpRequest })).rejects.toThrow(
			'Expected 2 shapes from the Delivery URL but got 1',
		);
	});
});

describe('EnterspeedContextGraph — Index › Query', () => {
	// The query-envelope contract's result: { id, index, items, totalCount, next }.
	const envelope = (id: string, items: IDataObject[] = [], next: string | null = null) => ({
		id,
		index: 'ProductIndex',
		items,
		totalCount: items.length,
		next,
	});
	const product = { $id: 'ProductIndex:productId:p-1001', sku: 'AUR-HP-100', name: 'Aurora H100', price: 2499 };

	/** Answers each query in the batch with its own envelope, by id. */
	const answerEach = (items: IDataObject[] = [product]) =>
		vi.fn(async (req: IDataObject) => (req.body as IDataObject[]).map((q) => envelope(q.id as string, items)));

	async function query(opts: {
		params?: Record<string, unknown>;
		items?: IDataObject[];
		httpRequest?: ReturnType<typeof vi.fn>;
		continueOnFail?: boolean;
	}) {
		const httpRequest = opts.httpRequest ?? answerEach();
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'index', operation: 'query', index: 'ProductIndex', specifyQuery: 'fields', ...opts.params },
			items: opts.items ?? [{}],
			httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return { out, httpRequest };
	}
	const body = (httpRequest: ReturnType<typeof vi.fn>) =>
		(httpRequest.mock.calls[0][0] as IDataObject).body as IDataObject[];

	it('explains the operation in a notice', () => {
		const notice = node.description.properties.find((p) => p.name === 'queryNotice');
		expect(notice?.type).toBe('notice');
	});

	it('POSTs an array of queries to /query/v1/{manifest} on the Delivery URL (ADR-030 §3)', async () => {
		const { httpRequest } = await query({});
		const req = httpRequest.mock.calls[0][0] as IDataObject;
		expect(req.method).toBe('POST');
		expect(req.url).toBe('http://localhost:5200/query/v1/1.0.0');
		expect(body(httpRequest)).toEqual([{ index: 'ProductIndex', limit: 20, page: 0, id: '0' }]);
	});

	it('builds filters, sort, cursor, search, aggregations and args from the fields', async () => {
		const { httpRequest } = await query({
			params: {
				'filtersUi.condition': [
					{ field: 'price', operator: 'greaterThan', value: '1000' },
					{ field: 'sku', operator: 'in', value: '["AUR-HP-100","AUR-SP-200"]' },
					{ field: 'categoryId', operator: 'equals', value: 'cat-speakers' },
				],
				filtersCombinator: 'or',
				'sortUi.item': [{ field: 'price', order: 'desc' }],
				pageSize: 10,
				page: 1,
				cursor: 'abc',
				queryOptions: {
					searchQuery: 'aurora',
					searchLiteral: true,
					searchFields: 'name, sku',
					aggregations: '[{"type":"values","name":"byCategory","field":"categoryId"}]',
					args: '{"min":1000}',
				},
			},
		});
		expect(body(httpRequest)[0]).toEqual({
			index: 'ProductIndex',
			filters: {
				or: [
					{ field: 'price', operator: 'greaterThan', value: 1000 },
					{ field: 'sku', operator: 'in', value: ['AUR-HP-100', 'AUR-SP-200'] },
					{ field: 'categoryId', operator: 'equals', value: 'cat-speakers' },
				],
			},
			sort: [{ field: 'price', order: 'desc' }],
			limit: 10,
			page: 1,
			cursor: 'abc',
			search: { query: 'aurora', literal: true, fields: ['name', 'sku'] },
			aggregations: [{ type: 'values', name: 'byCategory', field: 'categoryId' }],
			args: { min: 1000 },
			id: '0',
		});
	});

	it('sends one condition as a plain filter, without a combinator', async () => {
		const { httpRequest } = await query({
			params: { 'filtersUi.condition': [{ field: 'inStock', operator: 'equals', value: 'true' }] },
		});
		expect(body(httpRequest)[0].filters).toEqual({ field: 'inStock', operator: 'equals', value: true });
	});

	it('takes the whole query as JSON, with the index from its field', async () => {
		const { httpRequest } = await query({
			params: {
				specifyQuery: 'json',
				queryJson: '{"filters":{"and":[{"field":"price","operator":"lessThan","value":500}]}}',
			},
		});
		expect(body(httpRequest)).toEqual([
			{ filters: { and: [{ field: 'price', operator: 'lessThan', value: 500 }] }, index: 'ProductIndex', id: '0' },
		]);
	});

	it("sends every item's query in one request and outputs each result unchanged, paired to its item", async () => {
		const httpRequest = vi.fn(async (req: IDataObject) =>
			(req.body as IDataObject[])
				.map((q) => envelope(q.id as string, [product], q.id === '1' ? 'cursor-2' : null))
				.reverse(),
		);
		const { out } = await query({ items: [{}, {}], httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect(out).toEqual([
			{ json: envelope('0', [product]), pairedItem: { item: 0 } },
			{ json: envelope('1', [product], 'cursor-2'), pairedItem: { item: 1 } },
		]);
	});

	it('outputs an empty result, not a failure, when nothing matches', async () => {
		const { out } = await query({ httpRequest: answerEach([]) });
		expect(out[0].json).toEqual(envelope('0', []));
	});

	it('sends no request when there are no items', async () => {
		const { out, httpRequest } = await query({ items: [] });
		expect(httpRequest).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it('rejects an empty index before sending', async () => {
		const { httpRequest } = await query({ params: { index: ' ' }, continueOnFail: true });
		expect(httpRequest).not.toHaveBeenCalled();
		await expect(query({ params: { index: '' } })).rejects.toThrow('Item 0: Index is empty.');
	});

	it('rejects invalid JSON before sending', async () => {
		await expect(query({ params: { specifyQuery: 'json', queryJson: '{nope' } })).rejects.toThrow(
			'Item 0: Query (JSON) is not valid JSON.',
		);
	});

	describe('failed requests', () => {
		const failWith = (status: number, data?: unknown) =>
			vi.fn(async () => {
				throw Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), {
					cause: { response: { status, data } },
				});
			});

		it("shows the platform's message for an unknown index or invalid filter (400)", async () => {
			const data = { error: 'invalid_query', message: 'Unknown index "Nope".' };
			await expect(query({ httpRequest: failWith(400, data) })).rejects.toThrow('Unknown index "Nope".');
		});

		it('says when the API key is rejected (401)', async () => {
			await expect(query({ httpRequest: failWith(401) })).rejects.toThrow(
				'The API key was rejected by the Delivery URL.',
			);
		});

		it('says when the Delivery URL is unreachable', async () => {
			const httpRequest = vi.fn(async () => {
				throw new Error('connect ECONNREFUSED');
			});
			await expect(query({ httpRequest })).rejects.toThrow(
				"Couldn't reach the Delivery URL (http://localhost:5200/query/v1/1.0.0).",
			);
		});

		it('with Continue On Fail, fails every query in the rejected batch', async () => {
			const { out } = await query({
				items: [{}, {}],
				httpRequest: failWith(400, { message: 'Bad filter.' }),
				continueOnFail: true,
			});
			expect(out.map((o) => [o.json.error, o.pairedItem])).toEqual([
				['Bad filter.', { item: 0 }],
				['Bad filter.', { item: 1 }],
			]);
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
