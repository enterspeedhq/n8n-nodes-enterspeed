import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import type { ICredentialDataDecryptedObject, IDataObject, IHttpRequestOptions, INode, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { EnterspeedContextGraph } from '../nodes/EnterspeedContextGraph/EnterspeedContextGraph.node';
import {
	MAX_REQUEST_BYTES,
	MAX_THROTTLE_RETRIES,
} from '../nodes/EnterspeedContextGraph/actions/entity/shared';
import { MAX_BODY_BYTES } from '../nodes/EnterspeedContextGraph/actions/shape/getMany.operation';
import {
	DELIVERY_BUSY_MESSAGE,
	MAX_RETRY_AFTER_MS,
	deliveryRetryAfterMs,
	retryDelayMs,
} from '../nodes/EnterspeedContextGraph/transport';
import { EnterspeedContextGraphApi } from '../credentials/EnterspeedContextGraphApi.credentials';
import { createContextGraphExecuteMock } from './mocks';


// Retry waits (ingest/ADR-020 Retry-After) resolve at once, and are recorded.
const { sleep } = vi.hoisted(() => ({ sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}) }));
vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep,
}));

/**
 * Push sends each input item, as the record it is, to `POST {ingestUrl}/v1/entities`
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

		it('sends to {ingestUrl}/v1/entities as NDJSON with the Ingest API Key header', async () => {
			const { httpRequest } = await push({});
			const req = httpRequest.mock.calls[0][0] as IDataObject;
			expect(req.method).toBe('POST');
			// the trailing slash on the credential's Ingest URL is trimmed
			expect(req.url).toBe('http://localhost:5090/v1/entities');
			expect(req.headers).toEqual({ 'Content-Type': 'application/x-ndjson', 'X-Api-Key': 'cg-ingest-key' });
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

	describe('$source (required by ingest, cross/ADR-010; the node sends the record as it is)', () => {
		it('sends a record without $source as it is, leaving the rejection to the service', async () => {
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

		it('reports a record over the request limit (Kestrel default, 30,000,000 bytes) without sending it, and still pushes the rest', async () => {
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
			await expect(push({ httpRequest })).rejects.toThrow("Couldn't reach the Ingest URL (http://localhost:5090).");
		});

		it('does not put record content or the API key in the error', async () => {
			const httpRequest = vi.fn(async () => {
				throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
			});
			const error = await push({ items: [{ ...pimCategory, secretField: 'record-content' }], httpRequest }).catch(
				(e: Error) => e,
			);
			expect(String((error as Error).message)).not.toContain('record-content');
			expect(String((error as Error).message)).not.toContain('cg-ingest-key');
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
				error: "Couldn't reach the Ingest URL (http://localhost:5090).",
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

	it('splits a list only before the request limit (Kestrel default, 30,000,000 bytes)', async () => {
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
		expect(shapeFields.filter((p) => p.name !== 'operation').map((p) => p.name)).toEqual([
			'keyFrom',
			'shapeName',
			'idSegments',
			'shapeKey',
			'shapeKeys',
		]);
		// Existing workflows have no Key From, so they keep the text field.
		expect(field('keyFrom')?.default).toBe('shapeKey');
		expect(field('shapeKey')?.displayOptions?.show?.keyFrom).toEqual(['shapeKey']);
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

describe('EnterspeedContextGraph — Index › Get', () => {
	const p1001 = { $id: 'ProductIndex:productId:p-1001', sku: 'AUR-HP-100', name: 'Aurora H100', price: 2700 };

	async function get(opts: {
		params?: Record<string, unknown>;
		items?: IDataObject[];
		httpRequest?: ReturnType<typeof vi.fn>;
		continueOnFail?: boolean;
	}) {
		const httpRequest = opts.httpRequest ?? vi.fn(async () => p1001);
		const ctx = createContextGraphExecuteMock({
			params: {
				resource: 'index',
				operation: 'get',
				indexName: 'ProductIndex',
				documentId: 'ProductIndex:productId:p-1001',
				...opts.params,
			},
			items: opts.items ?? [{}],
			httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return { out, httpRequest };
	}
	const failWith = (status: number, data?: unknown) =>
		vi.fn(async () => {
			throw Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), {
				cause: { response: { status, data } },
			});
		});

	it("offers Get on the Index resource, with Index Name and a Document ID that defaults to the item's $id", () => {
		const shown = node.description.properties.filter(
			(p) =>
				(p.displayOptions?.show?.resource as string[] | undefined)?.includes('index') &&
				(p.displayOptions?.show?.operation as string[] | undefined)?.includes('get'),
		);
		expect(shown.map((p) => p.name)).toEqual(['getNotice', 'indexName', 'documentId']);
		expect(shown[2].default).toBe('={{ $json.$id }}');
		const operation = node.description.properties.find(
			(p) => p.name === 'operation' && (p.displayOptions?.show?.resource as string[]).includes('index'),
		);
		expect(operation?.options?.map((o) => (o as { value: string }).value)).toEqual(['get', 'query']);
	});

	it('GETs /query/v1/{manifest}/{indexName}/{documentId} on the Delivery URL (ADR-030 §3), the ID as one segment', async () => {
		const { httpRequest } = await get({});
		const req = httpRequest.mock.calls[0][0] as IDataObject;
		expect(req.method).toBe('GET');
		expect(req.url).toBe('http://localhost:5200/query/v1/1.0.0/ProductIndex/ProductIndex%3AproductId%3Ap-1001');
		expect((req.headers as IDataObject)['X-Api-Key']).toBe('cg-key');
	});

	it('percent-encodes both segments, so values with URL characters reach the service verbatim', async () => {
		const { httpRequest } = await get({ params: { indexName: 'My Index', documentId: 'I:sku:a/b?c#d%e' } });
		expect((httpRequest.mock.calls[0][0] as IDataObject).url).toBe(
			'http://localhost:5200/query/v1/1.0.0/My%20Index/I%3Asku%3Aa%2Fb%3Fc%23d%25e',
		);
	});

	it('outputs the document unchanged, one request per item, paired to its item', async () => {
		const ids = ['ProductIndex:productId:p-1001', 'ProductIndex:productId:p-1002'];
		const httpRequest = vi.fn(async (req: IDataObject) => ({ url: req.url }));
		const { out } = await get({ items: [{}, {}], params: { documentId: (i: number) => ids[i] }, httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		expect(String(out[1].json.url)).toContain('p-1002');
		const { out: one } = await get({});
		expect(one).toEqual([{ json: p1001, pairedItem: { item: 0 } }]);
	});

	it('parses a document that arrives as a string', async () => {
		const { out } = await get({ httpRequest: vi.fn(async () => JSON.stringify(p1001)) });
		expect(out[0].json).toEqual(p1001);
	});

	it('fails a blank or non-text Index Name or Document ID before sending', async () => {
		const httpRequest = vi.fn();
		await expect(get({ params: { indexName: ' ' }, httpRequest })).rejects.toThrow('Item 0 has no Index Name.');
		await expect(get({ params: { documentId: '' }, httpRequest })).rejects.toThrow('Item 0 has no Document ID.');
		await expect(get({ params: { documentId: 42 }, httpRequest })).rejects.toThrow(
			'Item 0 has a Document ID that is not text.',
		);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('fails a missing document (bodiless 404) with a message naming the index and the ID', async () => {
		await expect(get({ httpRequest: failWith(404) })).rejects.toThrow(
			'No document "ProductIndex:productId:p-1001" in index "ProductIndex".',
		);
	});

	it("shows the service's message for a 400, and says when the key is rejected or the URL unreachable", async () => {
		await expect(get({ httpRequest: failWith(400, { message: 'Unknown index "Nope".' }) })).rejects.toThrow(
			'Unknown index "Nope".',
		);
		await expect(get({ httpRequest: failWith(401) })).rejects.toThrow('The API key was rejected by the Delivery URL.');
		const unreachable = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});
		await expect(get({ httpRequest: unreachable })).rejects.toThrow("Couldn't reach the Delivery URL");
	});

	it('with Continue On Fail, outputs { indexName, documentId, error } for the failed item and keeps the others', async () => {
		const ids = ['ProductIndex:productId:gone', 'ProductIndex:productId:p-1001'];
		const httpRequest = vi.fn(async (req: IDataObject) => {
			if (String(req.url).includes('gone')) await failWith(404)();
			return p1001;
		});
		const { out } = await get({
			items: [{}, {}],
			params: { documentId: (i: number) => ids[i] },
			httpRequest,
			continueOnFail: true,
		});
		expect(out).toEqual([
			{
				json: {
					indexName: 'ProductIndex',
					documentId: 'ProductIndex:productId:gone',
					error: 'No document "ProductIndex:productId:gone" in index "ProductIndex".',
				},
				pairedItem: { item: 0 },
			},
			{ json: p1001, pairedItem: { item: 1 } },
		]);
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

	/** The id the platform gives a query: its own, else its position (query-envelope contract). */
	const idOf = (q: IDataObject, position: number) => (q.id === undefined || q.id === null ? String(position) : String(q.id));
	/** Answers each query in the batch with its own envelope, by id. */
	const answerEach = (items: IDataObject[] = [product]) =>
		vi.fn(async (req: IDataObject) => (req.body as IDataObject[]).map((q, i) => envelope(idOf(q, i), items)));

	async function query(opts: {
		params?: Record<string, unknown>;
		items?: IDataObject[];
		httpRequest?: ReturnType<typeof vi.fn>;
		continueOnFail?: boolean;
	}) {
		const httpRequest = opts.httpRequest ?? answerEach();
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'index', operation: 'query', query: '{"index":"ProductIndex"}', ...opts.params },
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

	it('takes the query as one JSON field, pre-filled with a working example, with a reference link in the hint', () => {
		const shown = node.description.properties.filter(
			(p) =>
				(p.displayOptions?.show?.resource as string[] | undefined)?.includes('index') &&
				!(p.displayOptions?.show?.operation as string[] | undefined)?.includes('get') &&
				!(p.displayOptions?.show?.queryFrom as string[] | undefined)?.includes('builder'),
		);
		expect(shown.map((p) => p.name)).toEqual(['operation', 'queryFrom', 'queryNotice', 'query', 'returnAll']);
		// JSON stays the default, so existing workflows are unchanged.
		expect(shown[1].default).toBe('json');
		shown.splice(1, 1);
		const [, notice, query] = shown;
		expect(notice.displayName).not.toContain('"index"');
		expect(query.type).toBe('json');
		expect(JSON.parse(query.default as string)).toEqual({
			index: 'ProductIndex',
			filters: {
				and: [
					{ field: 'inStock', operator: 'equals', value: true },
					{
						or: [
							{ field: 'price', operator: 'lessThan', value: 3000 },
							{ field: 'categoryId', operator: 'equals', value: 'cat-headphones' },
						],
					},
				],
			},
			sort: [{ field: 'price', direction: 'desc' }],
			limit: 20,
			page: 0,
		});
		expect(query.hint).toContain('#index--query');
	});

	it('POSTs an array of queries to /query/v1/{manifest} on the Delivery URL (ADR-030 §3)', async () => {
		const { httpRequest } = await query({});
		const req = httpRequest.mock.calls[0][0] as IDataObject;
		expect(req.method).toBe('POST');
		expect(req.url).toBe('http://localhost:5200/query/v1/1.0.0');
		expect(body(httpRequest)).toEqual([{ index: 'ProductIndex' }]);
	});

	it('sends the query exactly as written, adding nothing', async () => {
		const written = {
			index: 'ProductIndex',
			filters: {
				and: [
					{ field: 'categoryId', operator: 'equals', value: 'cat-headphones' },
					{ or: [{ field: 'inStock', operator: 'equals', value: true }, { field: 'price', operator: 'lessThan', value: 500 }] },
				],
			},
			sort: [{ field: 'price', order: 'desc' }],
			limit: 10,
			page: 1,
			cursor: 'abc',
			search: { query: 'aurora', literal: true, fields: ['name'] },
			aggregations: [{ type: 'values', name: 'byCategory', field: 'categoryId' }],
			args: { min: 1000 },
		};
		const { httpRequest } = await query({ params: { query: JSON.stringify(written) } });
		expect(body(httpRequest)).toEqual([written]);
	});

	it('takes the query as an object too (an expression)', async () => {
		const { httpRequest } = await query({ params: { query: { index: 'ProductIndex', limit: 5 } } });
		expect(body(httpRequest)).toEqual([{ index: 'ProductIndex', limit: 5 }]);
	});

	it("sends every item's query in one request and outputs each result unchanged, paired to its item", async () => {
		const httpRequest = vi.fn(async (req: IDataObject) =>
			(req.body as IDataObject[])
				.map((q, i) => envelope(idOf(q, i), [product], i === 1 ? 'cursor-2' : null))
				.reverse(),
		);
		const { out } = await query({ items: [{}, {}], httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect(out).toEqual([
			{ json: envelope('0', [product]), pairedItem: { item: 0 } },
			{ json: envelope('1', [product], 'cursor-2'), pairedItem: { item: 1 } },
		]);
	});

	it("keeps a query's own id and pairs its result by it", async () => {
		const ids = ['headphones', undefined];
		const httpRequest = vi.fn(async (req: IDataObject) =>
			(req.body as IDataObject[]).map((q, i) => envelope(idOf(q, i), [product])).reverse(),
		);
		const { out } = await query({
			items: [{}, {}],
			params: { query: (i: number) => ({ index: 'ProductIndex', id: ids[i] }) },
			httpRequest,
		});
		expect(body(httpRequest)).toEqual([{ index: 'ProductIndex', id: 'headphones' }, { index: 'ProductIndex' }]);
		expect(out.map((o) => [o.json.id, o.pairedItem])).toEqual([
			['headphones', { item: 0 }],
			['1', { item: 1 }],
		]);
	});

	describe('splitting at the 32 KiB body limit', () => {
		// About 1 KiB per query, so 40 items need two requests under 30 KiB each.
		const padded = (i: number) => ({ index: 'ProductIndex', args: { pad: 'x'.repeat(1000), n: i } });
		const sent = (httpRequest: ReturnType<typeof vi.fn>) =>
			httpRequest.mock.calls.map((c) => (c[0] as IDataObject).body as IDataObject[]);

		it('keeps every request body under 30 KiB and sends every query once, in order', async () => {
			const { httpRequest } = await query({ items: Array.from({ length: 40 }, () => ({})), params: { query: padded } });
			const bodies = sent(httpRequest);
			expect(bodies.length).toBe(2);
			for (const b of bodies) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThanOrEqual(30 * 1024);
			expect(bodies.flat().map((q) => (q.args as IDataObject).n)).toEqual(Array.from({ length: 40 }, (_, i) => i));
		});

		it("gives a query without an id its position in the run, so results pair across requests", async () => {
			const ids = (i: number) => (i === 3 ? 'own' : undefined);
			// Answers by the platform's rule within each request, reversed, as delivery may order them.
			const httpRequest = vi.fn(async (req: IDataObject) =>
				(req.body as IDataObject[]).map((q, i) => envelope(idOf(q, i), [product])).reverse(),
			);
			const { out } = await query({
				items: Array.from({ length: 40 }, () => ({})),
				params: { query: (i: number) => ({ ...padded(i), id: ids(i) }) },
				httpRequest,
			});
			const second = sent(httpRequest)[1];
			expect(second[0].id).toBe(String(40 - second.length));
			expect(out.map((o) => o.json.id)).toEqual(Array.from({ length: 40 }, (_, i) => (i === 3 ? 'own' : String(i))));
			expect(out.map((o) => o.pairedItem)).toEqual(Array.from({ length: 40 }, (_, i) => ({ item: i })));
		});

		it('fails a query too large for one request before sending, and still sends the others', async () => {
			const big = { index: 'ProductIndex', args: { pad: 'x'.repeat(31 * 1024) } };
			const { out, httpRequest } = await query({
				items: [{}, {}],
				params: { query: (i: number) => (i === 0 ? big : { index: 'ProductIndex' }) },
				continueOnFail: true,
			});
			expect(out[0].json.error).toBe('Item 0: Query is larger than the Delivery URL accepts in one request.');
			expect(body(httpRequest)).toEqual([{ index: 'ProductIndex' }]);
			expect(out[1].json.id).toBe('0');
		});

		it('refuses a split run in which two queries share an id, as one request would be refused', async () => {
			// Item 0 names itself "39", which is also the id-less last query's position; they land in different requests.
			const params = { query: (i: number) => ({ ...padded(i), id: i === 0 ? '39' : undefined }) };
			const httpRequest = answerEach();
			await expect(query({ items: Array.from({ length: 40 }, () => ({})), params, httpRequest })).rejects.toThrow(
				'Items 0 and 39 both have the query id "39". Each query in a run needs its own id.',
			);
			expect(httpRequest).not.toHaveBeenCalled();
			const { out } = await query({ items: Array.from({ length: 40 }, () => ({})), params, continueOnFail: true });
			expect(out.length).toBe(40);
			expect(out.every((o) => String(o.json.error).includes('both have the query id "39"'))).toBe(true);
		});

		it('with Continue On Fail, a failed request fails only its own queries', async () => {
			let call = 0;
			const httpRequest = vi.fn(async (req: IDataObject) => {
				if (call++ === 0) {
					throw Object.assign(new NodeApiError(httpNode, { httpCode: '400' }), {
						cause: { response: { status: 400, data: { message: 'Bad filter.' } } },
					});
				}
				return (req.body as IDataObject[]).map((q, i) => envelope(idOf(q, i), [product]));
			});
			const { out } = await query({
				items: Array.from({ length: 40 }, () => ({})),
				params: { query: padded },
				httpRequest,
				continueOnFail: true,
			});
			const firstSize = (httpRequest.mock.calls[0][0].body as IDataObject[]).length;
			expect(out.slice(0, firstSize).every((o) => o.json.error === 'Bad filter.')).toBe(true);
			expect(out.slice(firstSize).map((o) => o.json.id)).toEqual(
				Array.from({ length: 40 - firstSize }, (_, i) => String(firstSize + i)),
			);
		});
	});

	describe('Return All (follows next as cursor, query-envelope contract)', () => {
		const p = (n: number) => ({ ...product, $id: `ProductIndex:productId:p-${n}` });
		const sent = (httpRequest: ReturnType<typeof vi.fn>) =>
			httpRequest.mock.calls.map((c) => (c[0] as IDataObject).body as IDataObject[]);
		/** Answers each query from its own list of pages, by cursor: page k carries next `${id}:${k + 1}` unless it is the last. */
		const pagesFor = (pages: Record<string, IDataObject[][]>) =>
			vi.fn(async (req: IDataObject) =>
				(req.body as IDataObject[]).map((q, i) => {
					const id = idOf(q, i);
					const k = typeof q.cursor === 'string' ? Number(q.cursor.split(':')[1]) : 0;
					const last = k === pages[id].length - 1;
					return { ...envelope(id, pages[id][k], last ? null : `${id}:${k + 1}`), totalCount: 99 };
				}),
			);

		it('is off by default and shown for JSON and the Builder', () => {
			const returnAll = node.description.properties.find(
				(prop) => prop.name === 'returnAll' && (prop.displayOptions?.show?.resource as string[]).includes('index'),
			);
			expect(returnAll?.type).toBe('boolean');
			expect(returnAll?.default).toBe(false);
			expect(returnAll?.displayOptions?.show?.queryFrom).toBeUndefined();
		});

		it('re-sends only the queries that still have a next, each with its id and cursor, and merges their pages', async () => {
			const httpRequest = pagesFor({
				'0': [[p(1)]],
				'1': [[p(2)], [p(3)], [p(4)]],
				own: [[p(5)], [p(6)]],
			});
			const ids = [undefined, undefined, 'own'];
			const { out } = await query({
				items: [{}, {}, {}],
				params: { returnAll: true, query: (i: number) => ({ index: 'ProductIndex', limit: 1, id: ids[i] }) },
				httpRequest,
			});
			expect(sent(httpRequest)).toEqual([
				[
					{ index: 'ProductIndex', limit: 1 },
					{ index: 'ProductIndex', limit: 1 },
					{ index: 'ProductIndex', limit: 1, id: 'own' },
				],
				[
					{ index: 'ProductIndex', limit: 1, id: '1', cursor: '1:1' },
					{ index: 'ProductIndex', limit: 1, id: 'own', cursor: 'own:1' },
				],
				[{ index: 'ProductIndex', limit: 1, id: '1', cursor: '1:2' }],
			]);
			expect(out).toEqual([
				{ json: { ...envelope('0', [p(1)]), totalCount: 99 }, pairedItem: { item: 0 } },
				{ json: { ...envelope('1', [p(2), p(3), p(4)]), totalCount: 99 }, pairedItem: { item: 1 } },
				{ json: { ...envelope('own', [p(5), p(6)]), totalCount: 99 }, pairedItem: { item: 2 } },
			]);
		});

		it("keeps the first page's other members, such as aggregations", async () => {
			const aggregations = { byCategory: { buckets: [{ key: 'cat-headphones', count: 2 }] } };
			let call = 0;
			const httpRequest = vi.fn(async () =>
				call++ === 0 ? [{ ...envelope('0', [p(1)], 'c1'), aggregations }] : [{ ...envelope('0', [p(2)]), aggregations: {} }],
			);
			const { out } = await query({ params: { returnAll: true }, httpRequest });
			expect(out[0].json).toEqual({ ...envelope('0', [p(1), p(2)]), totalCount: 1, aggregations });
		});

		it('pages only the items that turn it on', async () => {
			const httpRequest = pagesFor({ '0': [[p(1)], [p(2)]], '1': [[p(3)], [p(4)]] });
			const createCtx = createContextGraphExecuteMock({
				params: { resource: 'index', operation: 'query', query: '{"index":"ProductIndex"}' },
				items: [{}, {}],
				httpRequest,
			});
			const getNodeParameter = createCtx.getNodeParameter;
			createCtx.getNodeParameter = ((name: string, i: number, fallback?: unknown) =>
				name === 'returnAll' ? i === 1 : getNodeParameter(name, i, fallback)) as typeof createCtx.getNodeParameter;
			const [out] = (await node.execute.call(createCtx)) as INodeExecutionData[][];
			expect(out[0].json).toEqual({ ...envelope('0', [p(1)], '0:1'), totalCount: 99 });
			expect(out[1].json.items).toEqual([p(3), p(4)]);
			expect(sent(httpRequest)[1]).toEqual([{ index: 'ProductIndex', id: '1', cursor: '1:1' }]);
		});

		it('fails a query that sets page before sending, and still sends page 0', async () => {
			const httpRequest = answerEach();
			const { out } = await query({
				items: [{}, {}],
				params: { returnAll: true, query: (i: number) => ({ index: 'ProductIndex', page: i === 0 ? 2 : 0 }) },
				httpRequest,
				continueOnFail: true,
			});
			expect(out[0].json.error).toBe(
				'Item 0: Query sets page, but Return All pages with the cursor. Remove page, or turn Return All off.',
			);
			expect(body(httpRequest)).toEqual([{ index: 'ProductIndex', page: 0 }]);
			await expect(query({ params: { returnAll: true, query: { index: 'ProductIndex', page: 1 } } })).rejects.toThrow(
				'Query sets page',
			);
		});

		it('hides the Builder\'s Page and sends no page from it', async () => {
			const page = node.description.properties.find((prop) => prop.name === 'page');
			expect(page?.displayOptions?.hide?.returnAll).toEqual([true]);
			const { httpRequest } = await query({
				params: { returnAll: true, queryFrom: 'builder', builderIndex: 'ProductIndex', queryLimit: 20, page: 3 },
			});
			expect(body(httpRequest)).toEqual([{ index: 'ProductIndex', limit: 20 }]);
		});

		it('fails a query whose next repeats instead of looping', async () => {
			const httpRequest = vi.fn(async () => [envelope('0', [p(1)], 'same')]);
			await expect(query({ params: { returnAll: true }, httpRequest })).rejects.toThrow(
				'Item 0: the Delivery URL returned the same next cursor twice for this query, so Return All stopped instead of looping.',
			);
			expect(httpRequest).toHaveBeenCalledTimes(2);
			// The query's own cursor counts as sent.
			const own = vi.fn(async () => [envelope('0', [p(1)], 'mine')]);
			const { out } = await query({
				params: { returnAll: true, query: { index: 'ProductIndex', cursor: 'mine' } },
				httpRequest: own,
				continueOnFail: true,
			});
			expect(own).toHaveBeenCalledTimes(1);
			expect(String(out[0].json.error)).toContain('same next cursor twice');
		});

		it('fails only the queries in a failed later round, as a failed first request does', async () => {
			let call = 0;
			const pages = pagesFor({ '0': [[p(1)]], '1': [[p(2)], [p(3)]] });
			const httpRequest = vi.fn(async (req: IDataObject) => {
				if (call++ === 1) {
					throw Object.assign(new NodeApiError(httpNode, { httpCode: '400' }), {
						cause: { response: { status: 400, data: { message: 'Bad cursor.' } } },
					});
				}
				return pages(req);
			});
			const { out } = await query({ items: [{}, {}], params: { returnAll: true }, httpRequest, continueOnFail: true });
			expect(out).toEqual([
				{ json: { ...envelope('0', [p(1)]), totalCount: 99 }, pairedItem: { item: 0 } },
				{ json: { error: 'Bad cursor.' }, pairedItem: { item: 1 } },
			]);
			call = 0;
			await expect(query({ items: [{}, {}], params: { returnAll: true }, httpRequest })).rejects.toThrow('Bad cursor.');
		});

		it('fails a query a later round answers nothing for', async () => {
			let call = 0;
			const httpRequest = vi.fn(async () => (call++ === 0 ? [envelope('0', [p(1)], 'c1')] : []));
			const { out } = await query({ params: { returnAll: true }, httpRequest, continueOnFail: true });
			expect(out[0].json.error).toBe('Item 0: the Delivery URL returned no result for this query.');
		});

		it('splits a later round under 30 KiB too, with every query by its id', async () => {
			const padded = (i: number) => ({ index: 'ProductIndex', args: { pad: 'x'.repeat(1000), n: i } });
			const pages = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i), [[p(i)], [p(100 + i)]]]));
			const httpRequest = pagesFor(pages);
			const { out } = await query({
				items: Array.from({ length: 40 }, () => ({})),
				params: { returnAll: true, query: padded },
				httpRequest,
			});
			const bodies = sent(httpRequest);
			expect(bodies.length).toBe(4);
			for (const b of bodies) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThanOrEqual(30 * 1024);
			const later = bodies.slice(2).flat();
			expect(later.map((q) => q.id)).toEqual(Array.from({ length: 40 }, (_, i) => String(i)));
			expect(later.every((q) => q.cursor === `${q.id}:1`)).toBe(true);
			expect(out.map((o) => o.json.items)).toEqual(Array.from({ length: 40 }, (_, i) => [p(i), p(100 + i)]));
		});
	});

	it('outputs an empty result, not a failure, when nothing matches', async () => {
		const { out } = await query({ httpRequest: answerEach([]) });
		expect(out[0].json).toEqual(envelope('0', []));
	});

	it('outputs the empty result the platform answers for an unknown index, not a failure', async () => {
		// Delivery drops a query on an unknown index to an empty result, not a 400, so
		// nobody can probe which indexes exist; its totalCount is null, not 0.
		const unknown = { id: '0', index: 'Nope', items: [], totalCount: null, next: null };
		const { out } = await query({
			params: { query: { index: 'Nope' } },
			httpRequest: vi.fn(async () => [unknown]),
		});
		expect(out).toEqual([{ json: unknown, pairedItem: { item: 0 } }]);
	});

	it('sends no request when there are no items', async () => {
		const { out, httpRequest } = await query({ items: [] });
		expect(httpRequest).not.toHaveBeenCalled();
		expect(out).toEqual([]);
	});

	it('rejects an empty query, a non-object or a query without index before sending', async () => {
		const { httpRequest } = await query({ params: { query: '' }, continueOnFail: true });
		expect(httpRequest).not.toHaveBeenCalled();
		await expect(query({ params: { query: ' ' } })).rejects.toThrow('Item 0: Query is empty.');
		await expect(query({ params: { query: '[]' } })).rejects.toThrow('Item 0: Query must be a JSON object.');
		await expect(query({ params: { query: '{"limit":5}' } })).rejects.toThrow('Item 0: Query has no index.');
	});

	it('rejects invalid JSON before sending', async () => {
		await expect(query({ params: { query: '{nope' } })).rejects.toThrow('Item 0: Query is not valid JSON.');
	});

	describe('failed requests', () => {
		const failWith = (status: number, data?: unknown) =>
			vi.fn(async () => {
				throw Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), {
					cause: { response: { status, data } },
				});
			});

		it("shows the platform's message for an invalid filter (400)", async () => {
			const data = "Field 'nope' on index 'ProductIndex' is not filterable.";
			await expect(query({ httpRequest: failWith(400, data) })).rejects.toThrow(
				"Field 'nope' on index 'ProductIndex' is not filterable.",
			);
		});

		it('says when the API key is rejected (401)', async () => {
			await expect(query({ httpRequest: failWith(401) })).rejects.toThrow(
				'The API key was rejected by the Delivery URL.',
			);
		});

		it("shows a problem body's detail when search can't answer (503, delivery/ADR-052)", async () => {
			const problem = {
				type: 'https://tools.ietf.org/html/rfc9110#section-15.6.4',
				title: 'Search unavailable',
				status: 503,
				detail: 'Search could not answer this batch. Retry after the time in Retry-After.',
			};
			// No Retry-After here, so no retry: the item fails as busy, with the detail as the description.
			const httpRequest = failWith(503, problem);
			const error = await query({ httpRequest }).catch((e: NodeApiError) => e);
			expect(error).toBeInstanceOf(NodeApiError);
			expect((error as NodeApiError).message).toBe(DELIVERY_BUSY_MESSAGE);
			expect((error as NodeApiError).description).toBe(problem.detail);
			expect(httpRequest).toHaveBeenCalledTimes(1);
		});

		it('falls back to the status for a problem body without a detail', async () => {
			await expect(query({ httpRequest: failWith(500, { title: 'Search failed', status: 500 }) })).rejects.toThrow(
				'The Delivery URL answered with status 500.',
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

		it("sends queries that share an id and passes on the platform's 400 (query-envelope contract)", async () => {
			const message = "Sub-queries at positions 0 and 1 would both be answered with id 'same'.";
			const httpRequest = failWith(400, message);
			await expect(
				query({ items: [{}, {}], params: { query: { index: 'ProductIndex', id: 'same' } }, httpRequest }),
			).rejects.toThrow(message);
			expect(httpRequest).toHaveBeenCalledTimes(1);
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

/**
 * Representation › Get reads one route per item from
 * `GET {deliveryUrl}/v1/{manifest}{route}` and outputs the body as it is:
 * each slot at its name, plus `$metadata` (Representation envelope contract).
 */
describe('EnterspeedContextGraph — Representation › Get', () => {
	// Tonevik's ProductPage for p-1001, as a stage 1 dev-server serves it.
	const productPage = {
		product: { categoryId: 'cat-headphones', id: 'productmodel:p-1001', name: 'Aurora H100 Over-Ear Headphones', price: 2700 },
		category: { id: 'categorymodel:cat-headphones', name: 'Headphones' },
		related: { id: 'related', index: 'ProductIndex', items: [], totalCount: 5, next: null },
		$metadata: { product: { $state: 'fresh' }, category: { $state: 'fresh' }, related: { $state: 'fresh' } },
	};
	// A slot that didn't resolve is null, and says so in $metadata.
	const partial = {
		product: productPage.product,
		category: null,
		$metadata: { product: { $state: 'fresh' }, category: { $state: 'missing' } },
	};

	async function readRepresentations(opts: {
		routes: unknown[];
		httpRequest: ReturnType<typeof vi.fn>;
		continueOnFail?: boolean;
	}) {
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'representation', operation: 'get', route: (i: number) => opts.routes[i] },
			items: opts.routes.map((route) => ({ route }) as IDataObject),
			httpRequest: opts.httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return out;
	}

	it('shows a Route field defaulting to the item\'s route', () => {
		const route = node.description.properties.find((p) => p.name === 'route');
		expect(route?.default).toBe('={{ $json.route }}');
		expect(route?.displayOptions?.show).toEqual({ resource: ['representation'], operation: ['get'], routeFrom: ['route'] });
		expect(node.description.properties.find((p) => p.name === 'routeFrom')?.default).toBe('route');
	});

	it('reads {deliveryUrl}/v1/{manifest}{route} with the API key', async () => {
		const httpRequest = vi.fn(async () => productPage);
		await readRepresentations({ routes: ['/products/p-1001'], httpRequest });
		const req = httpRequest.mock.calls[0][0] as IDataObject;
		expect(req.method).toBe('GET');
		expect(req.url).toBe('http://localhost:5200/v1/1.0.0/products/p-1001');
		expect((req.headers as IDataObject)['X-Api-Key']).toBe('cg-key');
	});

	it('outputs the representation exactly as delivered, $metadata included, paired to its item', async () => {
		const out = await readRepresentations({ routes: ['/products/p-1001'], httpRequest: vi.fn(async () => productPage) });
		expect(out).toEqual([{ json: productPage, pairedItem: { item: 0 } }]);
	});

	it('outputs a partly resolved representation as a success, with the missing slot null', async () => {
		const out = await readRepresentations({ routes: ['/products/p-1001'], httpRequest: vi.fn(async () => partial) });
		expect(out[0].json).toEqual(partial);
	});

	it('sends one request per item and keeps the output in item order', async () => {
		const httpRequest = vi.fn(async (req: IDataObject) => ({ route: String(req.url).split('/').pop(), $metadata: {} }));
		const out = await readRepresentations({ routes: ['/products/p-1001', '/products/p-1002'], httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(out.map((o) => o.json.route)).toEqual(['p-1001', 'p-1002']);
		expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});

	it('percent-encodes each segment and keeps the slashes', async () => {
		const httpRequest = vi.fn(async () => ({ $metadata: {} }));
		await readRepresentations({ routes: ['/da/søg/a b%c'], httpRequest });
		expect((httpRequest.mock.calls[0][0] as IDataObject).url).toBe(
			'http://localhost:5200/v1/1.0.0/da/s%C3%B8g/a%20b%25c',
		);
	});

	it('parses a representation that arrives as a string', async () => {
		const out = await readRepresentations({
			routes: ['/products/p-1001'],
			httpRequest: vi.fn(async () => JSON.stringify(productPage)),
		});
		expect(out[0].json).toEqual(productPage);
	});

	describe('a route that is not sent', () => {
		it.each([
			['', 'Item 0 has no Route.'],
			[undefined, 'Item 0 has no Route.'],
			[42, 'Item 0 has a Route that is not text.'],
			['products/p-1001', 'Item 0 has a Route that doesn\'t start with "/" ("products/p-1001").'],
			// A query string would be encoded into the path; query values go through Route From › Schema.
			['/categories/c-1?brandId=b-1', 'Item 0 has a Route with "?" or "#" ("/categories/c-1?brandId=b-1"). Give only the path; to send query or header values, set Route From to Schema.'],
			['/products/p-1001#top', 'Item 0 has a Route with "?" or "#"'],
		])('%j fails before anything is sent', async (route, message) => {
			const httpRequest = vi.fn();
			await expect(readRepresentations({ routes: [route], httpRequest })).rejects.toThrow(message);
			expect(httpRequest).not.toHaveBeenCalled();
		});
	});

	describe('no representation (404)', () => {
		it("uses the service's own message, e.g. an unresolved required slot", async () => {
			const httpRequest = vi.fn(async () => {
				throw n8nError(404, { error: 'not_found', message: 'Required slot "product" could not be resolved.' });
			});
			await expect(readRepresentations({ routes: ['/products/p-1010'], httpRequest })).rejects.toThrow(
				'Required slot "product" could not be resolved.',
			);
		});

		it('names the route when the 404 has no body', async () => {
			const httpRequest = vi.fn(async () => {
				throw httpError(404);
			});
			await expect(readRepresentations({ routes: ['/nothing/here'], httpRequest })).rejects.toThrow(
				'No representation for route "/nothing/here".',
			);
		});
	});

	it("passes an invalid request's message through (400)", async () => {
		const httpRequest = vi.fn(async () => {
			throw n8nError(400, { message: 'Route value "x" is not a valid productId.' });
		});
		await expect(readRepresentations({ routes: ['/products/x'], httpRequest })).rejects.toThrow(
			'Route value "x" is not a valid productId.',
		);
	});

	it('words a rejected key (401) without the service body', async () => {
		const httpRequest = vi.fn(async () => {
			throw n8nError(401);
		});
		await expect(readRepresentations({ routes: ['/products/p-1001'], httpRequest })).rejects.toThrow(
			'The API key was rejected by the Delivery URL.',
		);
	});

	it('reports an unreachable Delivery URL', async () => {
		const httpRequest = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});
		await expect(readRepresentations({ routes: ['/products/p-1001'], httpRequest })).rejects.toThrow(
			"Couldn't reach the Delivery URL (http://localhost:5200).",
		);
	});

	it('with Continue On Fail, reports the failed route and reads the next', async () => {
		const httpRequest = vi
			.fn()
			.mockRejectedValueOnce(n8nError(404, { message: 'Required slot "product" could not be resolved.' }))
			.mockResolvedValueOnce(productPage);
		const out = await readRepresentations({
			routes: ['/products/p-1010', '/products/p-1001'],
			httpRequest,
			continueOnFail: true,
		});
		expect(out).toEqual([
			{
				json: { route: '/products/p-1010', error: 'Required slot "product" could not be resolved.' },
				pairedItem: { item: 0 },
			},
			{ json: productPage, pairedItem: { item: 1 } },
		]);
	});
});

/**
 * Resume Partial Answers follows `$metadata.$resume` with `X-Resume` on the
 * same route (delivery/ADR-033) and merges each round by slot name. The
 * answers below are the Representation envelope's `follows` vector pairs,
 * with a stand-in token where the vectors expect `$resume` present.
 */
describe('EnterspeedContextGraph — Representation › Get, resuming a partial answer', () => {
	// deferred-slot-carries-resume → resume-round-completes-open-slot
	const deferredFirst = {
		product: { sku: 'p1' },
		price: null,
		$metadata: { product: { $state: 'fresh' }, price: { $state: 'deferred' }, $resume: 'token-1' },
	};
	const deferredRound = { price: { amount: 129, currency: 'DKK' }, $metadata: { price: { $state: 'fresh' } } };
	// pending-slot-carries-resume → resume-round-still-open-carries-resume
	const pendingFirst = {
		product: { sku: 'p1' },
		reviews: null,
		$metadata: { product: { $state: 'fresh' }, reviews: { $state: 'pending', $timeoutMs: 250 }, $resume: 'token-1' },
	};
	const stillOpen = (token: string) => ({
		reviews: null,
		$metadata: { reviews: { $state: 'pending', $timeoutMs: 250 }, $resume: token },
	});

	const refused = (status: number, wwwAuthenticate?: string, data?: unknown) =>
		Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), {
			cause: {
				response: { status, data, headers: wwwAuthenticate ? { 'www-authenticate': wwwAuthenticate } : {} },
			},
		});

	async function read(opts: {
		httpRequest: ReturnType<typeof vi.fn>;
		resume?: boolean;
		maxRounds?: number;
		maxWaitMs?: number;
		continueOnFail?: boolean;
		params?: Record<string, unknown>;
	}) {
		sleep.mockClear();
		const ctx = createContextGraphExecuteMock({
			params: {
				resource: 'representation',
				operation: 'get',
				route: '/products/p1',
				resumePartial: opts.resume ?? true,
				...(opts.maxRounds !== undefined && { maxResumeRounds: opts.maxRounds }),
				...(opts.maxWaitMs !== undefined && { maxResumeWaitMs: opts.maxWaitMs }),
				...opts.params,
			},
			items: [{}],
			httpRequest: opts.httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return out;
	}
	const resumeHeader = (httpRequest: ReturnType<typeof vi.fn>, call: number) =>
		((httpRequest.mock.calls[call][0] as IDataObject).headers as IDataObject)['X-Resume'];

	it('is off by default, and off outputs the partial answer as it is with one request', async () => {
		expect(node.description.properties.find((p) => p.name === 'resumePartial')?.default).toBe(false);
		const httpRequest = vi.fn(async () => deferredFirst);
		const out = await read({ httpRequest, resume: false });
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect(out).toEqual([{ json: deferredFirst, pairedItem: { item: 0 } }]);
	});

	it('sends the checkpoint unchanged in X-Resume to the same route, and merges the round by slot name', async () => {
		const httpRequest = vi.fn().mockResolvedValueOnce(deferredFirst).mockResolvedValueOnce(deferredRound);
		const out = await read({ httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(2);
		const [first, second] = httpRequest.mock.calls.map((c) => c[0] as IDataObject);
		expect(second.url).toBe(first.url);
		expect(resumeHeader(httpRequest, 0)).toBeUndefined();
		expect(resumeHeader(httpRequest, 1)).toBe('token-1');
		expect(out).toEqual([
			{
				json: {
					product: { sku: 'p1' },
					price: { amount: 129, currency: 'DKK' },
					$metadata: { product: { $state: 'fresh' }, price: { $state: 'fresh' } },
				},
				pairedItem: { item: 0 },
			},
		]);
	});

	it('resumes a deferred slot at once: it carries no $timeoutMs', async () => {
		const httpRequest = vi.fn().mockResolvedValueOnce(deferredFirst).mockResolvedValueOnce(deferredRound);
		await read({ httpRequest });
		expect(sleep).not.toHaveBeenCalled();
	});

	it("chains with each round's fresh checkpoint, and stops at Max Rounds with the slot still open", async () => {
		const httpRequest = vi
			.fn()
			.mockResolvedValueOnce(pendingFirst)
			.mockResolvedValueOnce(stillOpen('token-2'))
			.mockResolvedValueOnce(stillOpen('token-3'));
		const out = await read({ httpRequest, maxRounds: 2 });
		expect(httpRequest).toHaveBeenCalledTimes(3);
		expect([resumeHeader(httpRequest, 1), resumeHeader(httpRequest, 2)]).toEqual(['token-1', 'token-2']);
		const metadata = out[0].json.$metadata as IDataObject;
		expect(metadata.reviews).toEqual({ $state: 'pending', $timeoutMs: 250 });
		// The latest checkpoint stays, so the answer can still be continued.
		expect(metadata.$resume).toBe('token-3');
		expect(out[0].json.product).toEqual({ sku: 'p1' });
	});

	it('defaults Max Rounds to 3', async () => {
		expect(node.description.properties.find((p) => p.name === 'maxResumeRounds')?.default).toBe(3);
		const httpRequest = vi.fn().mockResolvedValueOnce(pendingFirst).mockResolvedValue(stillOpen('token-n'));
		await read({ httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(4);
	});

	it('waits the largest $timeoutMs among the open slots, capped by Max Wait Between Rounds', async () => {
		const twoPending = {
			a: null,
			b: null,
			$metadata: { a: { $state: 'pending', $timeoutMs: 300 }, b: { $state: 'pending', $timeoutMs: 1200 }, $resume: 't' },
		};
		const done = { a: 1, b: 2, $metadata: { a: { $state: 'fresh' }, b: { $state: 'fresh' } } };
		await read({ httpRequest: vi.fn().mockResolvedValueOnce(twoPending).mockResolvedValueOnce(done) });
		expect(sleep.mock.calls).toEqual([[1200]]);
		await read({ httpRequest: vi.fn().mockResolvedValueOnce(twoPending).mockResolvedValueOnce(done), maxWaitMs: 500 });
		expect(sleep.mock.calls).toEqual([[500]]);
	});

	it('keeps the newest $changedAt across rounds', async () => {
		const first = { ...deferredFirst, $metadata: { ...deferredFirst.$metadata, $changedAt: '2026-09-03T09:14:22.123Z' } };
		const round = { ...deferredRound, $metadata: { ...deferredRound.$metadata, $changedAt: '2026-09-04T10:00:00.000Z' } };
		const older = { ...deferredRound, $metadata: { ...deferredRound.$metadata, $changedAt: '2026-01-01T00:00:00.000Z' } };
		const newer = await read({ httpRequest: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(round) });
		expect((newer[0].json.$metadata as IDataObject).$changedAt).toBe('2026-09-04T10:00:00.000Z');
		const kept = await read({ httpRequest: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(older) });
		expect((kept[0].json.$metadata as IDataObject).$changedAt).toBe('2026-09-03T09:14:22.123Z');
	});

	describe('the client resume guard (no context token is sent)', () => {
		it('sends no round when every open slot names a claim in $requires', async () => {
			const gated = {
				offers: null,
				$metadata: { offers: { $state: 'deferred', $requires: ['segment'] }, $resume: 't' },
			};
			const httpRequest = vi.fn(async () => gated);
			const out = await read({ httpRequest });
			expect(httpRequest).toHaveBeenCalledTimes(1);
			expect(out[0].json).toEqual(gated);
		});

		it('resumes when $requires is empty, and ignores a gated slot beside it', async () => {
			const mixed = {
				offers: null,
				related: null,
				$metadata: {
					offers: { $state: 'deferred', $requires: ['segment'] },
					related: { $state: 'deferred', $requires: [] },
					$resume: 't',
				},
			};
			const round = {
				offers: null,
				related: { items: [] },
				$metadata: { offers: { $state: 'deferred', $requires: ['segment'] }, related: { $state: 'fresh' }, $resume: 't2' },
			};
			const httpRequest = vi.fn().mockResolvedValueOnce(mixed).mockResolvedValueOnce(round);
			const out = await read({ httpRequest });
			// After the round only the gated slot is open, so no further round.
			expect(httpRequest).toHaveBeenCalledTimes(2);
			expect(out[0].json.related).toEqual({ items: [] });
		});
	});

	it('sends no round for an answer without $resume, e.g. a non-resumable representation', async () => {
		const noCheckpoint = { price: null, $metadata: { price: { $state: 'deferred' } } };
		const httpRequest = vi.fn(async () => noCheckpoint);
		await read({ httpRequest });
		expect(httpRequest).toHaveBeenCalledTimes(1);
	});

	it('repeats the query string and headers on a resume round (Route From › Schema)', async () => {
		const httpRequest = vi.fn().mockResolvedValueOnce(deferredFirst).mockResolvedValueOnce(deferredRound);
		await read({
			httpRequest,
			params: {
				routeFrom: 'schema',
				representationRoute: '/products/{productId}',
				'context.value': { 'path:productId': 'p1', 'query:locale': 'da', 'header:market': 'dk' },
				'context.schema': [{ id: 'path:productId' }, { id: 'query:locale' }, { id: 'header:market' }],
			},
		});
		const [first, second] = httpRequest.mock.calls.map((c) => c[0] as IDataObject);
		expect(second.url).toBe(first.url);
		expect(second.qs).toEqual({ locale: 'da' });
		expect(second.headers).toMatchObject({ 'X-Delivery-market': 'dk', 'X-Resume': 'token-1' });
	});

	describe('a refused checkpoint (delivery/ADR-033 §3)', () => {
		it.each([
			['401 invalid_checkpoint', refused(401, 'X-Resume error="invalid_checkpoint"')],
			['410 checkpoint_expired', refused(410, 'X-Resume error="checkpoint_expired"')],
			['409 another manifest or resource', refused(409, undefined, 'Checkpoint does not match the requested resource.')],
		])('%s reads the route again without the checkpoint, once', async (_name, error) => {
			const httpRequest = vi
				.fn()
				.mockResolvedValueOnce(deferredFirst)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ product: { sku: 'p1' }, price: { amount: 1 }, $metadata: { product: { $state: 'fresh' }, price: { $state: 'fresh' } } });
			const out = await read({ httpRequest });
			expect(httpRequest).toHaveBeenCalledTimes(3);
			expect(resumeHeader(httpRequest, 2)).toBeUndefined();
			expect(out[0].json.price).toEqual({ amount: 1 });
		});

		it('fails the item when the checkpoint is refused again after the fallback', async () => {
			const httpRequest = vi
				.fn()
				.mockResolvedValueOnce(deferredFirst)
				.mockRejectedValueOnce(refused(409, undefined, 'Checkpoint manifest does not match.'))
				.mockResolvedValueOnce(deferredFirst)
				.mockRejectedValueOnce(refused(409, undefined, 'Checkpoint manifest does not match.'));
			await expect(read({ httpRequest })).rejects.toThrow('Checkpoint manifest does not match.');
		});

		it('treats a 401 without the checkpoint hint as a rejected key', async () => {
			const httpRequest = vi.fn().mockResolvedValueOnce(deferredFirst).mockRejectedValueOnce(refused(401));
			await expect(read({ httpRequest })).rejects.toThrow('The API key was rejected by the Delivery URL.');
			expect(httpRequest).toHaveBeenCalledTimes(2);
		});

		it('treats a 410 without the checkpoint hint as a retired API version', async () => {
			const httpRequest = vi.fn().mockResolvedValueOnce(deferredFirst).mockRejectedValueOnce(refused(410));
			await expect(read({ httpRequest })).rejects.toThrow('no longer serves API version');
		});
	});

	it('fails the item on a 404 in a resume round, and with Continue On Fail outputs the error', async () => {
		const httpRequest = vi
			.fn()
			.mockResolvedValueOnce(deferredFirst)
			.mockRejectedValueOnce(refused(404, undefined, { message: 'Required slot "product" could not be resolved.' }));
		const out = await read({ httpRequest, continueOnFail: true });
		expect(out).toEqual([
			{
				json: { route: '/products/p1', error: 'Required slot "product" could not be resolved.' },
				pairedItem: { item: 0 },
			},
		]);
	});
});

/**
 * If-None-Match and Include Response Headers (sc-13417 in delivery's
 * RepresentationEndpoints): a complete 200 to a fresh GET carries a weak
 * ETag, and a matching If-None-Match is answered 304 with the same headers
 * and no body. n8n's request helper fails a 304 like any status outside 2xx,
 * with the response as the failure's cause.
 */
describe('EnterspeedContextGraph — Representation › Get, revalidating with an ETag', () => {
	const etag = 'W/"5f0c3e"';
	const page = { product: { sku: 'p1' }, $metadata: { product: { $state: 'fresh' } } };
	const full = (body: unknown, statusCode = 200, headers: IDataObject = {}) => ({ body, statusCode, statusMessage: 'OK', headers });
	const tagged = full(page, 200, {
		etag,
		'cache-control': 'public, max-age=0, must-revalidate',
		vary: 'Accept-Encoding',
		'cache-tag': 'graph:p1',
		'x-delivery-resolved': '1',
		'content-type': 'application/json; charset=utf-8',
	});
	const notModified = (headers: IDataObject = { etag, 'cache-control': 'public, max-age=0, must-revalidate' }) =>
		Object.assign(new NodeApiError(httpNode, { httpCode: '304' }), { cause: { response: { status: 304, headers, data: '' } } });

	async function read(params: Record<string, unknown>, httpRequest: ReturnType<typeof vi.fn>, continueOnFail = false) {
		sleep.mockClear();
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'representation', operation: 'get', route: '/products/p1', ...params },
			items: [{}],
			httpRequest,
			continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return out;
	}
	const sent = (httpRequest: ReturnType<typeof vi.fn>, call = 0) => httpRequest.mock.calls[call][0] as IDataObject;
	const sentHeader = (httpRequest: ReturnType<typeof vi.fn>, name: string, call = 0) =>
		(sent(httpRequest, call).headers as IDataObject | undefined)?.[name];

	it('defaults both fields to off, and sends and outputs exactly what it did before', async () => {
		expect(node.description.properties.find((p) => p.name === 'ifNoneMatch')?.default).toBe('');
		expect(node.description.properties.find((p) => p.name === 'includeResponseHeaders')?.default).toBe(false);
		const httpRequest = vi.fn(async () => page);
		const out = await read({}, httpRequest);
		expect(sent(httpRequest)).toEqual({
			method: 'GET',
			url: 'http://localhost:5200/v1/1.0.0/products/p1',
			json: true,
			headers: { 'X-Api-Key': 'cg-key' },
		});
		expect(out).toEqual([{ json: page, pairedItem: { item: 0 } }]);
	});

	it('sends If-None-Match as given and reads the full response', async () => {
		const httpRequest = vi.fn(async () => tagged);
		const out = await read({ ifNoneMatch: `${etag}, "other"` }, httpRequest);
		expect(sentHeader(httpRequest, 'If-None-Match')).toBe(`${etag}, "other"`);
		expect(sent(httpRequest).returnFullResponse).toBe(true);
		expect(sent(httpRequest).ignoreHttpStatusErrors).toBeUndefined();
		// A changed representation: without headers, the body as before.
		expect(out).toEqual([{ json: page, pairedItem: { item: 0 } }]);
	});

	it.each(['', '   '])('sends no If-None-Match when it is %j', async (ifNoneMatch) => {
		const httpRequest = vi.fn(async () => page);
		const out = await read({ ifNoneMatch }, httpRequest);
		expect(sentHeader(httpRequest, 'If-None-Match')).toBeUndefined();
		expect(sent(httpRequest).returnFullResponse).toBeUndefined();
		expect(out[0].json).toEqual(page);
	});

	it('with Include Response Headers, outputs { status, headers, body } with the ETag and the cache headers only', async () => {
		const httpRequest = vi.fn(async () => tagged);
		const out = await read({ includeResponseHeaders: true }, httpRequest);
		expect(sentHeader(httpRequest, 'If-None-Match')).toBeUndefined();
		expect(out).toEqual([
			{
				json: {
					status: 200,
					headers: { 'Cache-Tag': 'graph:p1', ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate', Vary: 'Accept-Encoding' },
					body: page,
				},
				pairedItem: { item: 0 },
			},
		]);
	});

	it('a 304 with headers comes out as { status: 304, headers, body: null }', async () => {
		const httpRequest = vi.fn().mockRejectedValue(notModified());
		const out = await read({ ifNoneMatch: etag, includeResponseHeaders: true }, httpRequest);
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect(out).toEqual([
			{
				json: { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=0, must-revalidate' }, body: null },
				pairedItem: { item: 0 },
			},
		]);
	});

	it('a 304 without headers comes out as { notModified: true }', async () => {
		const out = await read({ ifNoneMatch: etag }, vi.fn().mockRejectedValue(notModified()));
		expect(out).toEqual([{ json: { notModified: true }, pairedItem: { item: 0 } }]);
	});

	it('a 304 that answers a retried 503 still counts as not modified', async () => {
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		try {
			const busy = Object.assign(new NodeApiError(httpNode, { httpCode: '503' }), {
				cause: { response: { status: 503, headers: { 'retry-after': '1' } } },
			});
			const httpRequest = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(notModified());
			const out = await read({ ifNoneMatch: etag }, httpRequest);
			expect(httpRequest).toHaveBeenCalledTimes(2);
			expect(sentHeader(httpRequest, 'If-None-Match', 1)).toBe(etag);
			expect(out[0].json).toEqual({ notModified: true });
		} finally {
			random.mockRestore();
		}
	});

	it('a 304 to a read that sent no If-None-Match fails the item, as any unexpected status does', async () => {
		await expect(read({ includeResponseHeaders: true }, vi.fn().mockRejectedValue(notModified()))).rejects.toThrow(
			'The Delivery URL answered with status 304.',
		);
	});

	it('a partial answer carries no ETag, and the node adds none', async () => {
		const partialPage = { product: null, $metadata: { product: { $state: 'pending', $timeoutMs: 100 } } };
		const httpRequest = vi.fn(async () => full(partialPage, 207, { 'cache-control': 'private, no-store' }));
		const out = await read({ ifNoneMatch: etag, includeResponseHeaders: true }, httpRequest);
		expect(out[0].json).toEqual({ status: 207, headers: { 'Cache-Control': 'private, no-store' }, body: partialPage });
	});

	it('with Resume Partial Answers, sends If-None-Match only on the first read and outputs the last response\'s headers', async () => {
		const first = {
			product: { sku: 'p1' },
			price: null,
			$metadata: { product: { $state: 'fresh' }, price: { $state: 'deferred' }, $resume: 'token-1' },
		};
		const round = { price: { amount: 129 }, $metadata: { price: { $state: 'fresh' } } };
		const httpRequest = vi
			.fn()
			.mockResolvedValueOnce(full(first, 207, { 'cache-control': 'private, no-store' }))
			.mockResolvedValueOnce(full(round, 200, { 'cache-control': 'private, no-store', vary: 'X-Resume' }));
		const out = await read({ ifNoneMatch: etag, includeResponseHeaders: true, resumePartial: true }, httpRequest);
		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(sentHeader(httpRequest, 'If-None-Match', 0)).toBe(etag);
		expect(sentHeader(httpRequest, 'If-None-Match', 1)).toBeUndefined();
		expect(sentHeader(httpRequest, 'X-Resume', 1)).toBe('token-1');
		expect(out[0].json).toEqual({
			status: 200,
			headers: { 'Cache-Control': 'private, no-store', Vary: 'X-Resume' },
			body: {
				product: { sku: 'p1' },
				price: { amount: 129 },
				$metadata: { product: { $state: 'fresh' }, price: { $state: 'fresh' } },
			},
		});
	});

	it('with Resume Partial Answers, a complete tagged first answer is output as it is, with its ETag', async () => {
		const httpRequest = vi.fn(async () => tagged);
		const out = await read({ includeResponseHeaders: true, resumePartial: true }, httpRequest);
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect((out[0].json.headers as IDataObject).ETag).toBe(etag);
	});

	it('after a refused checkpoint, outputs the fresh read\'s own status and ETag, and sends no If-None-Match on it', async () => {
		const first = {
			product: { sku: 'p1' },
			price: null,
			$metadata: { product: { $state: 'fresh' }, price: { $state: 'deferred' }, $resume: 'token-1' },
		};
		const expired = Object.assign(new NodeApiError(httpNode, { httpCode: '410' }), {
			cause: { response: { status: 410, headers: { 'www-authenticate': 'X-Resume error="checkpoint_expired"' } } },
		});
		const httpRequest = vi
			.fn()
			.mockResolvedValueOnce(full(first, 207, { 'cache-control': 'private, no-store' }))
			.mockRejectedValueOnce(expired)
			.mockResolvedValueOnce(tagged);
		const out = await read({ ifNoneMatch: '"stale"', includeResponseHeaders: true, resumePartial: true }, httpRequest);
		expect(httpRequest).toHaveBeenCalledTimes(3);
		expect(sentHeader(httpRequest, 'If-None-Match', 2)).toBeUndefined();
		expect(sentHeader(httpRequest, 'X-Resume', 2)).toBeUndefined();
		expect(out[0].json).toMatchObject({ status: 200, headers: { ETag: etag }, body: page });
	});

	it('an error carries no ETag: with Continue On Fail it is output as before', async () => {
		const httpRequest = vi.fn().mockRejectedValue(n8nError(404, { message: 'Required slot "product" could not be resolved.' }));
		const out = await read({ ifNoneMatch: etag, includeResponseHeaders: true }, httpRequest, true);
		expect(out).toEqual([
			{ json: { route: '/products/p1', error: 'Required slot "product" could not be resolved.' }, pairedItem: { item: 0 } },
		]);
	});

	it('sends If-None-Match alongside a schema request\'s own headers', async () => {
		const httpRequest = vi.fn(async () => tagged);
		await read(
			{
				routeFrom: 'schema',
				representation: 'ProductPage',
				representationRoute: '/products/{productId}',
				'context.value': { 'path:productId': 'p1', 'header:market': 'dk' },
				'context.schema': [{ id: 'path:productId', required: true }, { id: 'header:market' }],
				ifNoneMatch: etag,
			},
			httpRequest,
		);
		expect(sent(httpRequest).url).toBe('http://localhost:5200/v1/1.0.0/products/p1');
		expect(sentHeader(httpRequest, 'If-None-Match')).toBe(etag);
		expect(sentHeader(httpRequest, 'X-Delivery-market')).toBe('dk');
	});
});

/**
 * delivery/ADR-025 Decision 3: a read Delivery can't serve right now is
 * answered 503 + Retry-After + X-Delivery-Retry-After-Ms. Every Delivery read
 * waits that long plus a jitter and sends the same request once more, as
 * Delivery's own clients do.
 */
describe('EnterspeedContextGraph — a busy Delivery (503, delivery/ADR-025 D3)', () => {
	const busy = (headers: IDataObject = { 'Retry-After': '1', 'X-Delivery-Retry-After-Ms': '1000' }, data?: unknown) =>
		Object.assign(new NodeApiError(httpNode, { httpCode: '503' }), { cause: { response: { status: 503, headers, data } } });

	describe('the wait asked for', () => {
		it('takes X-Delivery-Retry-After-Ms over Retry-After', () => {
			expect(deliveryRetryAfterMs({ 'x-delivery-retry-after-ms': '250', 'retry-after': '5' })).toBe(250);
		});

		it('falls back to Retry-After in whole seconds', () => {
			expect(deliveryRetryAfterMs({ 'retry-after': '2' })).toBe(2000);
		});

		it('reads the headers in any case', () => {
			expect(deliveryRetryAfterMs({ 'X-Delivery-Retry-After-Ms': '300' })).toBe(300);
			expect(deliveryRetryAfterMs({ 'Retry-After': '1' })).toBe(1000);
		});

		it('falls back to Retry-After when X-Delivery-Retry-After-Ms is unusable', () => {
			expect(deliveryRetryAfterMs({ 'x-delivery-retry-after-ms': '-5', 'retry-after': '1' })).toBe(1000);
			expect(deliveryRetryAfterMs({ 'x-delivery-retry-after-ms': 'soon', 'retry-after': '1' })).toBe(1000);
		});

		it('has no usable value without either header, or with an HTTP date or a fraction of a second in Retry-After', () => {
			expect(deliveryRetryAfterMs({})).toBeUndefined();
			expect(deliveryRetryAfterMs(undefined)).toBeUndefined();
			expect(deliveryRetryAfterMs({ 'retry-after': new Date(Date.now() + 2000).toUTCString() })).toBeUndefined();
			expect(deliveryRetryAfterMs({ 'retry-after': '1.5' })).toBeUndefined();
			expect(deliveryRetryAfterMs({ 'retry-after': '' })).toBeUndefined();
		});

		it(`takes up to ${MAX_RETRY_AFTER_MS} ms, and nothing above it`, () => {
			expect(MAX_RETRY_AFTER_MS).toBe(30_000);
			expect(deliveryRetryAfterMs({ 'x-delivery-retry-after-ms': '30000' })).toBe(30_000);
			expect(deliveryRetryAfterMs({ 'retry-after': '30' })).toBe(30_000);
			expect(deliveryRetryAfterMs({ 'x-delivery-retry-after-ms': '30001' })).toBeUndefined();
			expect(deliveryRetryAfterMs({ 'retry-after': '31' })).toBeUndefined();
		});
	});

	describe('the jitter, in [0, min(wait / 2, 1 s))', () => {
		const almostOne = () => 0.999999;
		it('adds nothing at the bottom of its range', () => {
			expect(retryDelayMs(1000, () => 0)).toBe(1000);
		});

		it('stays under half the wait for a short wait', () => {
			expect(retryDelayMs(1000, almostOne)).toBe(1499);
			expect(retryDelayMs(250, almostOne)).toBe(374);
		});

		it('stays under 1 s for a long wait', () => {
			expect(retryDelayMs(5000, almostOne)).toBe(5999);
			expect(retryDelayMs(30_000, almostOne)).toBe(30_999);
		});

		it('adds nothing to a wait of 0', () => {
			expect(retryDelayMs(0, almostOne)).toBe(0);
		});

		it('uses a random value when none is given', () => {
			const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
			try {
				expect(retryDelayMs(1000)).toBe(1250);
			} finally {
				random.mockRestore();
			}
		});
	});

	/** Each Delivery read, run once: its parameters, and an answer that succeeds. */
	const reads: Array<[string, Record<string, unknown>, unknown]> = [
		['Shape › Get', { resource: 'shape', operation: 'get', shapeKey: 'CategoryRef:categoryId:cat-speakers' }, { name: 'Speakers' }],
		[
			'Shape › Get Many',
			{ resource: 'shape', operation: 'getMany', shapeKeys: ['CategoryRef:categoryId:cat-speakers'] },
			[{ key: 'CategoryRef:categoryId:cat-speakers', status: 200, data: { name: 'Speakers' } }],
		],
		[
			'Shape › Get Many (Schema)',
			{ resource: 'shape', operation: 'getMany', keyFrom: 'schema', shapeName: 'CategoryRef', idSegments: { segment: [{ name: 'categoryId', value: 'cat-speakers' }] } },
			[{ key: 'CategoryRef:categoryId:cat-speakers', status: 200, data: { name: 'Speakers' } }],
		],
		['Index › Get', { resource: 'index', operation: 'get', indexName: 'ProductIndex', documentId: 'ProductIndex:productId:p-1001' }, { $id: 'p-1001' }],
		[
			'Index › Query',
			{ resource: 'index', operation: 'query', query: '{"index":"ProductIndex"}' },
			[{ id: '0', index: 'ProductIndex', items: [], totalCount: 0, next: null }],
		],
		['Representation › Get', { resource: 'representation', operation: 'get', route: '/products/p1' }, { product: { sku: 'p1' }, $metadata: { product: { $state: 'fresh' } } }],
	];

	async function run(params: Record<string, unknown>, httpRequest: ReturnType<typeof vi.fn>, continueOnFail = false) {
		sleep.mockClear();
		const ctx = createContextGraphExecuteMock({ params, items: [{}], httpRequest, continueOnFail });
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		return out;
	}

	describe.each(reads)('%s', (_name, params, answer) => {
		it('waits the wait asked for plus jitter, then sends the same request once more', async () => {
			const random = vi.spyOn(Math, 'random').mockReturnValue(0);
			try {
				const httpRequest = vi.fn().mockRejectedValueOnce(busy({ 'x-delivery-retry-after-ms': '250', 'retry-after': '1' })).mockResolvedValueOnce(answer);
				const out = await run(params, httpRequest);
				expect(sleep.mock.calls).toEqual([[250]]);
				expect(httpRequest).toHaveBeenCalledTimes(2);
				expect(httpRequest.mock.calls[1][0]).toEqual(httpRequest.mock.calls[0][0]);
				expect(out[0].json.error).toBeUndefined();
			} finally {
				random.mockRestore();
			}
		});

		it('fails the item as busy on a second 503', async () => {
			const httpRequest = vi.fn().mockRejectedValue(busy());
			await expect(run(params, httpRequest)).rejects.toThrow(DELIVERY_BUSY_MESSAGE);
			expect(httpRequest).toHaveBeenCalledTimes(2);
			expect(sleep).toHaveBeenCalledTimes(1);
		});

		it('with Continue On Fail, outputs the item with error', async () => {
			const out = await run(params, vi.fn().mockRejectedValue(busy()), true);
			expect(out).toHaveLength(1);
			expect(out[0].json.error).toBe(DELIVERY_BUSY_MESSAGE);
			expect(out[0].pairedItem).toEqual({ item: 0 });
		});

		it.each([
			['no wait', {}],
			['a wait over 30 s', { 'x-delivery-retry-after-ms': '60000', 'retry-after': '60' }],
		])("doesn't retry a 503 with %s, and fails the item as busy", async (_case, headers) => {
			const httpRequest = vi.fn().mockRejectedValue(busy(headers));
			await expect(run(params, httpRequest)).rejects.toThrow(DELIVERY_BUSY_MESSAGE);
			expect(httpRequest).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		});

		it("doesn't retry any other failure", async () => {
			const httpRequest = vi.fn().mockRejectedValue(
				Object.assign(new NodeApiError(httpNode, { httpCode: '500' }), { cause: { response: { status: 500, headers: { 'retry-after': '1' } } } }),
			);
			await expect(run(params, httpRequest)).rejects.toThrow('The Delivery URL answered with status 500.');
			expect(httpRequest).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		});
	});

	it("shows why in the description when the 503's problem body has a detail", async () => {
		const problem = { title: 'Search unavailable', status: 503, detail: 'Search could not answer this batch. Retry after the time in Retry-After.' };
		const out = await run(
			{ resource: 'shape', operation: 'get', shapeKey: 'CategoryRef:categoryId:cat-speakers' },
			vi.fn().mockRejectedValue(busy({ 'retry-after': '1' }, problem)),
			true,
		);
		expect(out[0].json).toEqual({ key: 'CategoryRef:categoryId:cat-speakers', error: DELIVERY_BUSY_MESSAGE, description: problem.detail });
	});

	it("Index › Query: retries search's 503 once, then fails every query in the batch as busy with the problem's detail", async () => {
		const problem = { title: 'Search unavailable', status: 503, detail: 'Search could not answer this batch. Retry after the time in Retry-After.' };
		const httpRequest = vi.fn().mockRejectedValue(busy({ 'Retry-After': '5', 'X-Delivery-Retry-After-Ms': '5000' }, problem));
		const out = await run({ resource: 'index', operation: 'query', query: '{"index":"ProductIndex"}' }, httpRequest, true);
		expect(httpRequest).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(5000);
		expect(sleep.mock.calls[0][0]).toBeLessThan(6000);
		expect(out).toEqual([{ json: { error: DELIVERY_BUSY_MESSAGE, description: problem.detail }, pairedItem: { item: 0 } }]);
	});

	it('passes on a failure other than 503 on the retry as it is', async () => {
		const httpRequest = vi
			.fn()
			.mockRejectedValueOnce(busy())
			.mockRejectedValueOnce(Object.assign(new NodeApiError(httpNode, { httpCode: '404' }), { cause: { response: { status: 404 } } }));
		await expect(
			run({ resource: 'shape', operation: 'get', shapeKey: 'CategoryRef:categoryId:cat-speakers' }, httpRequest),
		).rejects.toThrow('No shape for key "CategoryRef:categoryId:cat-speakers".');
	});

	describe('Representation › Get, resuming a partial answer', () => {
		const deferredFirst = {
			product: { sku: 'p1' },
			price: null,
			$metadata: { product: { $state: 'fresh' }, price: { $state: 'deferred' }, $resume: 'token-1' },
		};
		const deferredRound = { price: { amount: 129 }, $metadata: { price: { $state: 'fresh' } } };
		const params = { resource: 'representation', operation: 'get', route: '/products/p1', resumePartial: true };

		it('retries a resume round once on a 503, with the same checkpoint', async () => {
			const random = vi.spyOn(Math, 'random').mockReturnValue(0);
			try {
				const httpRequest = vi
					.fn()
					.mockResolvedValueOnce(deferredFirst)
					.mockRejectedValueOnce(busy())
					.mockResolvedValueOnce(deferredRound);
				const out = await run(params, httpRequest);
				expect(httpRequest).toHaveBeenCalledTimes(3);
				expect(sleep.mock.calls).toEqual([[1000]]);
				const resumeOf = (call: number) => ((httpRequest.mock.calls[call][0] as IDataObject).headers as IDataObject)['X-Resume'];
				expect([resumeOf(1), resumeOf(2)]).toEqual(['token-1', 'token-1']);
				expect(out[0].json.price).toEqual({ amount: 129 });
			} finally {
				random.mockRestore();
			}
		});

		it('fails the item as busy when the resume round is shed twice', async () => {
			const httpRequest = vi.fn().mockResolvedValueOnce(deferredFirst).mockRejectedValue(busy());
			const out = await run(params, httpRequest, true);
			expect(httpRequest).toHaveBeenCalledTimes(3);
			expect(out[0].json).toEqual({ route: '/products/p1', error: DELIVERY_BUSY_MESSAGE });
		});
	});
});

describe('EnterspeedContextGraphApi credential', () => {
	const field = (name: string) => credential.properties.find((p) => p.name === name);

	it('has an ingest URL and key, a delivery URL and key, and a manifest version', () => {
		expect(credential.properties.map((p) => p.name).sort()).toEqual(
			['deliveryApiKey', 'deliveryUrl', 'ingestApiKey', 'ingestUrl', 'manifestVersion'].sort(),
		);
	});

	it('masks both keys', () => {
		expect(field('ingestApiKey')?.typeOptions?.password).toBe(true);
		expect(field('deliveryApiKey')?.typeOptions?.password).toBe(true);
	});

	it("doesn't pre-fill either URL with an Enterspeed Core host", () => {
		expect(field('ingestUrl')?.default).toBe('');
		expect(field('deliveryUrl')?.default).toBe('');
		expect(field('ingestUrl')?.required).toBe(true);
		expect(field('deliveryUrl')?.required).toBe(true);
	});

	describe('sends each key only to its own service, as the X-Api-Key header', () => {
		const creds = {
			ingestUrl: 'https://ingest.example.com/',
			ingestApiKey: 'ingest-key',
			deliveryUrl: 'https://delivery.example.com',
			deliveryApiKey: 'delivery-key',
			manifestVersion: '1.0.0',
		};
		const authenticate = credential.authenticate as (
			c: ICredentialDataDecryptedObject,
			r: IHttpRequestOptions,
		) => Promise<IHttpRequestOptions>;
		const header = async (url: string) => (await authenticate(creds, { url, headers: { a: 'b' } })).headers;

		it('the Ingest API Key to the Ingest URL and under it', async () => {
			expect(await header('https://ingest.example.com/v1/entities')).toEqual({ a: 'b', 'X-Api-Key': 'ingest-key' });
			expect(await header('https://ingest.example.com')).toEqual({ a: 'b', 'X-Api-Key': 'ingest-key' });
		});

		it('the Delivery API Key everywhere else', async () => {
			expect(await header('https://delivery.example.com/schema/msd/v1/1.0.0')).toEqual({ a: 'b', 'X-Api-Key': 'delivery-key' });
			// a host that only starts with the ingest URL isn't under it
			expect(await header('https://ingest.example.com.evil/v1/entities')).toEqual({ a: 'b', 'X-Api-Key': 'delivery-key' });
		});

		it('the Delivery API Key to the credential test, which has a baseURL', async () => {
			const out = await authenticate(creds, { baseURL: 'https://delivery.example.com', url: '/schema/msd/v1/1.0.0' });
			expect(out.headers).toEqual({ 'X-Api-Key': 'delivery-key' });
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

/**
 * Artifact › Upload sends a snapshot source's complete export through the
 * artifact drop (*Ingest artifact* spec; ingest/ADR-017 D1): reserve with the
 * four declared facts, PUT the bytes to the signed URL with exactly the
 * headers the reservation names, commit, and output the artifact unchanged.
 */
describe('EnterspeedContextGraph — Artifact › Upload', () => {
	// Two of Tonevik's PIM lines, verbatim, as the export file's bytes.
	const exportFile = Buffer.from(
		'{"$id":"pim-cat-dd34d4","$type":"category","$source":"pim","id":"cat-speakers","name":"Speakers"}\n' +
			'{"$id":"pim-cat-1f0e9a","$type":"category","$source":"pim","id":"cat-headphones","name":"Headphones"}\n',
	);
	const ingest = 'http://localhost:5090';
	const signedUrl = 'https://storage.example/artifacts/a-1?sig=SECRET-SIGNATURE';
	const reservation = {
		id: 'a-1',
		source: 'pim',
		state: 'reserved',
		asOf: '2026-11-19T02:00:00Z',
		rowCount: 2,
		upload: { url: signedUrl, method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, expiresAt: '2026-11-19T03:00:00Z' },
	};
	const committed = { ...reservation, state: 'committed', upload: null, committedAt: '2026-11-19T02:01:00Z', sizeBytes: exportFile.length };

	const params = {
		resource: 'artifact',
		operation: 'upload',
		sourceAlias: 'pim',
		binaryPropertyName: 'data',
		contentType: 'ndjson',
		asOf: '2026-11-19T02:00:00Z',
		rowCount: '2',
	};

	/** Answers reserve, upload and commit as the artifact drop does. */
	function drop(reserve: IDataObject = reservation) {
		return vi.fn(async (req: IHttpRequestOptions) => {
			if (req.url === `${ingest}/v1/sources/pim/artifacts`) return reserve;
			if (req.url === signedUrl) return '';
			if (req.url === `${ingest}/v1/sources/pim/artifacts/a-1/commit`) return committed;
			throw new Error(`Unexpected request to ${req.url}`);
		});
	}

	/** A refusal as n8n hands it over: problem details in the HTTP error's body. */
	const refusal = (status: number, reason: string, title: string, detail: string) =>
		Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), {
			cause: {
				response: {
					status,
					data: { type: `urn:enterspeed:problem:artifact:${reason}`, title, status, detail },
				},
			},
		});

	async function upload(
		opts: {
			params?: Record<string, unknown>;
			binaries?: Array<Record<string, Buffer> | undefined>;
			httpRequest?: ReturnType<typeof vi.fn>;
			continueOnFail?: boolean;
		} = {},
	) {
		const binaries = opts.binaries ?? [{ data: exportFile }];
		const httpRequest = opts.httpRequest ?? drop();
		const ctx = createContextGraphExecuteMock({
			params: { ...params, ...opts.params },
			items: binaries.map(() => ({})),
			binaries,
			httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		const calls = httpRequest.mock.calls.map((c) => c[0] as IHttpRequestOptions);
		return { out, calls };
	}

	describe('reserve, upload, commit (ingest/ADR-017 D1)', () => {
		it('reserves with the four declared facts, with the Ingest API Key', async () => {
			const { calls } = await upload();
			expect(calls[0]).toMatchObject({
				method: 'POST',
				url: `${ingest}/v1/sources/pim/artifacts`,
				headers: { 'X-Api-Key': 'cg-ingest-key' },
				body: {
					asOf: '2026-11-19T02:00:00Z',
					rowCount: 2,
					contentType: 'application/x-ndjson',
					contentHash: createHash('sha256').update(exportFile).digest('hex'),
				},
			});
		});

		it('sends CSV as text/csv', async () => {
			const { calls } = await upload({ params: { contentType: 'csv' } });
			expect((calls[0].body as IDataObject).contentType).toBe('text/csv');
		});

		it('takes Row Count as given, as a number or as text, never counting the file', async () => {
			const { calls } = await upload({ params: { rowCount: 1250000 } });
			expect((calls[0].body as IDataObject).rowCount).toBe(1250000);
		});

		it('uploads the bytes unchanged to the signed URL, with exactly its headers and no API key', async () => {
			const { calls } = await upload();
			expect(calls[1]).toEqual({
				method: 'PUT',
				url: signedUrl,
				headers: { 'x-ms-blob-type': 'BlockBlob' },
				body: exportFile,
				json: false,
			});
		});

		it('commits, and outputs the committed artifact unchanged, paired to its item', async () => {
			const { out, calls } = await upload();
			expect(calls[2]).toMatchObject({
				method: 'POST',
				url: `${ingest}/v1/sources/pim/artifacts/a-1/commit`,
				headers: { 'X-Api-Key': 'cg-ingest-key' },
			});
			expect(calls).toHaveLength(3);
			expect(out).toEqual([{ json: committed, pairedItem: { item: 0 } }]);
		});

		it('uploads one file per item, in order', async () => {
			const { out, calls } = await upload({ binaries: [{ data: exportFile }, { data: exportFile }] });
			expect(calls.map((c) => c.url)).toEqual([
				`${ingest}/v1/sources/pim/artifacts`,
				signedUrl,
				`${ingest}/v1/sources/pim/artifacts/a-1/commit`,
				`${ingest}/v1/sources/pim/artifacts`,
				signedUrl,
				`${ingest}/v1/sources/pim/artifacts/a-1/commit`,
			]);
			expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		});

		it('reads the file from the Input Binary Field', async () => {
			const { calls } = await upload({ params: { binaryPropertyName: 'export' }, binaries: [{ export: exportFile }] });
			expect(calls[1].body).toBe(exportFile);
		});
	});

	describe('a retry (ingest/ADR-017 D3)', () => {
		it('outputs an already committed artifact as answered, uploading and committing nothing', async () => {
			const { out, calls } = await upload({ httpRequest: drop(committed) });
			expect(calls).toHaveLength(1);
			expect(out).toEqual([{ json: committed, pairedItem: { item: 0 } }]);
		});

		it('uploads and commits again when the retried reservation is not committed yet', async () => {
			const { calls } = await upload({ httpRequest: drop({ ...reservation }) });
			expect(calls.map((c) => c.url)).toEqual([
				`${ingest}/v1/sources/pim/artifacts`,
				signedUrl,
				`${ingest}/v1/sources/pim/artifacts/a-1/commit`,
			]);
		});
	});

	describe('refusals (Ingest artifact spec: problem details)', () => {
		it('names a refusal by its problem type, with the platform title and detail', async () => {
			const httpRequest = vi.fn(async () => {
				throw refusal(
					409,
					'push-source',
					'A push source takes no artifacts.',
					"Only a snapshot source accepts an upload. Push the rows to POST /v1/entities, or change the source's mode.",
				);
			});
			await expect(upload({ httpRequest })).rejects.toMatchObject({
				message: 'A push source takes no artifacts. (push-source)',
				description: "Only a snapshot source accepts an upload. Push the rows to POST /v1/entities, or change the source's mode.",
			});
			expect(httpRequest).toHaveBeenCalledTimes(1);
		});

		it('names a refusal at commit too', async () => {
			const httpRequest = vi.fn(async (req: IHttpRequestOptions) => {
				if (req.url.endsWith('/commit')) throw refusal(409, 'not-uploaded', 'Nothing was uploaded.', 'Upload the file first.');
				return req.url === signedUrl ? '' : reservation;
			});
			await expect(upload({ httpRequest })).rejects.toMatchObject({ message: 'Nothing was uploaded. (not-uploaded)' });
		});

		it('says the Ingest URL was unreachable when nothing answered', async () => {
			const httpRequest = vi.fn(async () => {
				throw new Error('connect ECONNREFUSED');
			});
			await expect(upload({ httpRequest })).rejects.toMatchObject({
				message: `Couldn't reach the Ingest URL (${ingest}).`,
			});
		});

		it("names a failed upload by the storage's origin only, never the signed URL", async () => {
			const httpRequest = vi.fn(async (req: IHttpRequestOptions) => {
				if (req.url === signedUrl) throw n8nFailure(403);
				return reservation;
			});
			const error = await upload({ httpRequest }).catch((e: Error) => e);
			expect(error).toMatchObject({ message: 'The upload to https://storage.example failed with status 403.' });
			expect(JSON.stringify(error)).not.toContain('SECRET-SIGNATURE');
			expect(httpRequest).toHaveBeenCalledTimes(2);
		});
	});

	describe('checked before anything is sent', () => {
		it.each([
			['no Source', { sourceAlias: '' }, 'Item 0 has no Source.'],
			['no As Of', { asOf: ' ' }, 'Item 0 has no As Of.'],
			['no Row Count', { rowCount: '' }, 'Item 0 has no Row Count.'],
			['a negative Row Count', { rowCount: '-1' }, 'Item 0 has a Row Count that is not a whole number of 0 or more.'],
			['a fractional Row Count', { rowCount: 1.5 }, 'Item 0 has a Row Count that is not a whole number of 0 or more.'],
			['a Row Count that is not a number', { rowCount: 'many' }, 'Item 0 has a Row Count that is not a whole number of 0 or more.'],
		])('fails an item with %s', async (_, override, message) => {
			const httpRequest = drop();
			await expect(upload({ params: override, httpRequest })).rejects.toMatchObject({ message });
			expect(httpRequest).not.toHaveBeenCalled();
		});

		it('fails an item whose file n8n cannot hold in memory, naming the limit', async () => {
			const httpRequest = drop();
			const ctx = createContextGraphExecuteMock({
				params,
				binaries: [{ data: exportFile }],
				httpRequest,
			});
			ctx.helpers.getBinaryDataBuffer = async () => {
				throw Object.assign(new RangeError('File size (2147483648) is greater than 2 GiB'), { code: 'ERR_FS_FILE_TOO_LARGE' });
			};
			await expect(node.execute.call(ctx)).rejects.toMatchObject({
				message: 'Item 0 has a file too large for n8n to hold in memory (2 GiB or more); the limit is 2 GB.',
			});
			expect(httpRequest).not.toHaveBeenCalled();
		});

		it('fails an item with no binary data in the Input Binary Field', async () => {
			const httpRequest = drop();
			await expect(upload({ binaries: [undefined], httpRequest })).rejects.toMatchObject({
				message: 'Item 0 has no binary data in "data".',
			});
			expect(httpRequest).not.toHaveBeenCalled();
		});
	});

	describe('Continue On Fail', () => {
		it('outputs a failed item as its source, as-of and error, and goes on with the next', async () => {
			const { out } = await upload({
				params: { rowCount: (i: number) => (i === 0 ? '' : '2') },
				binaries: [{ data: exportFile }, { data: exportFile }],
				continueOnFail: true,
			});
			expect(out).toEqual([
				{
					json: { source: 'pim', asOf: '2026-11-19T02:00:00Z', error: 'Item 0 has no Row Count.' },
					pairedItem: { item: 0 },
				},
				{ json: committed, pairedItem: { item: 1 } },
			]);
		});
	});
});

/**
 * Artifact › Get, Get Many and Get Lines read what became of an upload
 * (*Ingest artifact* spec: status, list, the artifact's lines), with the
 * Ingest API Key, and output each answer as returned, paired to its item.
 */
describe('EnterspeedContextGraph — Artifact › Get, Get Many, Get Lines', () => {
	const ingest = 'http://localhost:5090';
	const artifactsAt = `${ingest}/v1/sources/pim/artifacts`;
	const id = '0b8a3c2e-6f51-4d0a-9a4e-3f1c2b7d9e10';
	const line = (number: number) => ({ number, outcome: 'refused', type: 'product', id: `P-${number}`, reason: 'policy-forbids' });
	const drained = {
		id,
		source: 'pim',
		state: 'drained',
		upload: null,
		drain: { recordsPresented: 3, recordsDrained: 3, result: { applied: 1, refused: 2 } },
		lines: [line(1), line(2)],
		nextAfter: null,
	};
	const listed = (n: number) => ({ id: `a-${n}`, source: 'pim', state: 'drained', upload: null, lines: null, nextAfter: null });

	const refusal = (status: number, reason: string, title: string, detail: string) =>
		Object.assign(new NodeApiError(httpNode, { httpCode: String(status) }), {
			cause: {
				response: { status, data: { type: `urn:enterspeed:problem:artifact:${reason}`, title, status, detail } },
			},
		});

	async function run(opts: {
		params: Record<string, unknown>;
		httpRequest: ReturnType<typeof vi.fn>;
		items?: number;
		continueOnFail?: boolean;
	}) {
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'artifact', sourceAlias: 'pim', ...opts.params },
			items: Array.from({ length: opts.items ?? 1 }, () => ({})),
			httpRequest: opts.httpRequest,
			continueOnFail: opts.continueOnFail,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		const calls = opts.httpRequest.mock.calls.map((c) => c[0] as IHttpRequestOptions);
		return { out, calls };
	}

	describe('Get', () => {
		const params = { operation: 'get', artifactId: id };

		it('reads the status route with the Ingest API Key and outputs the artifact as returned', async () => {
			const httpRequest = vi.fn(async () => drained);
			const { out, calls } = await run({ params, httpRequest });
			expect(calls).toEqual([
				expect.objectContaining({ method: 'GET', url: `${artifactsAt}/${id}`, qs: {}, headers: { 'X-Api-Key': 'cg-ingest-key' } }),
			]);
			expect(out).toEqual([{ json: drained, pairedItem: { item: 0 } }]);
		});

		it('reads one artifact per item, each paired to its item', async () => {
			const httpRequest = vi.fn(async () => drained);
			const { out } = await run({ params: { ...params, artifactId: (i: number) => `00000000-0000-0000-0000-00000000000${i}` }, httpRequest, items: 2 });
			expect(httpRequest.mock.calls.map((c) => (c[0] as IHttpRequestOptions).url)).toEqual([
				`${artifactsAt}/00000000-0000-0000-0000-000000000000`,
				`${artifactsAt}/00000000-0000-0000-0000-000000000001`,
			]);
			expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		});

		it.each([
			['no Source', { sourceAlias: ' ' }, 'Item 0 has no Source.'],
			['no Artifact ID', { artifactId: '' }, 'Item 0 has no Artifact ID.'],
		])('fails an item with %s before anything is sent', async (_, override, message) => {
			const httpRequest = vi.fn();
			await expect(run({ params: { ...params, ...override }, httpRequest })).rejects.toMatchObject({ message });
			expect(httpRequest).not.toHaveBeenCalled();
		});
	});

	describe('Get Many', () => {
		const params = { operation: 'getMany', returnAll: false, limit: 50, state: '' };

		it('reads one page of Limit artifacts and outputs each as returned, paired to its item', async () => {
			const httpRequest = vi.fn(async () => ({ source: 'pim', artifacts: [listed(1), listed(2)], nextCursor: 'c-1' }));
			const { out, calls } = await run({ params: { ...params, limit: 2 }, httpRequest });
			expect(calls).toEqual([
				expect.objectContaining({ method: 'GET', url: artifactsAt, qs: { limit: 2 }, headers: { 'X-Api-Key': 'cg-ingest-key' } }),
			]);
			expect(out).toEqual([
				{ json: listed(1), pairedItem: { item: 0 } },
				{ json: listed(2), pairedItem: { item: 0 } },
			]);
		});

		it('sends State as the state filter', async () => {
			const httpRequest = vi.fn(async () => ({ source: 'pim', artifacts: [], nextCursor: null }));
			const { calls, out } = await run({ params: { ...params, state: 'failed' }, httpRequest });
			expect(calls[0].qs).toEqual({ limit: 50, state: 'failed' });
			expect(out).toEqual([]);
		});

		it('with Return All, follows nextCursor with the same state until it is null, 200 a page', async () => {
			const pages = [
				{ source: 'pim', artifacts: [listed(1)], nextCursor: 'c-1' },
				{ source: 'pim', artifacts: [listed(2)], nextCursor: 'c-2' },
				{ source: 'pim', artifacts: [listed(3)], nextCursor: null },
			];
			const httpRequest = vi.fn(async () => pages.shift());
			const { calls, out } = await run({ params: { ...params, returnAll: true, state: 'drained' }, httpRequest });
			expect(calls.map((c) => c.qs)).toEqual([
				{ limit: 200, state: 'drained' },
				{ limit: 200, state: 'drained', cursor: 'c-1' },
				{ limit: 200, state: 'drained', cursor: 'c-2' },
			]);
			expect(out.map((o) => o.json.id)).toEqual(['a-1', 'a-2', 'a-3']);
			expect(out.every((o) => (o.pairedItem as { item: number }).item === 0)).toBe(true);
		});

		it('pairs each listing to the item it came from', async () => {
			const httpRequest = vi.fn(async (req: IHttpRequestOptions) => ({
				source: req.url.split('/').at(-2),
				artifacts: [listed(1)],
				nextCursor: null,
			}));
			const { calls, out } = await run({ params: { ...params, sourceAlias: (i: number) => `src-${i}` }, httpRequest, items: 2 });
			expect(calls.map((c) => c.url)).toEqual([`${ingest}/v1/sources/src-0/artifacts`, `${ingest}/v1/sources/src-1/artifacts`]);
			expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		});

		it.each([0, 201, 1.5])('fails an item whose Limit is %s before anything is sent', async (limit) => {
			const httpRequest = vi.fn();
			await expect(run({ params: { ...params, limit }, httpRequest })).rejects.toMatchObject({
				message: 'Item 0 has a Limit that is not a whole number from 1 to 200.',
			});
			expect(httpRequest).not.toHaveBeenCalled();
		});
	});

	describe('Get Lines', () => {
		const params = { operation: 'getLines', artifactId: id, returnAll: false, limit: 50 };

		it('outputs each line as returned, one item each, paired to its item', async () => {
			const httpRequest = vi.fn(async () => drained);
			const { out, calls } = await run({ params, httpRequest });
			expect(calls).toEqual([
				expect.objectContaining({ method: 'GET', url: `${artifactsAt}/${id}`, qs: {}, headers: { 'X-Api-Key': 'cg-ingest-key' } }),
			]);
			expect(out).toEqual([
				{ json: line(1), pairedItem: { item: 0 } },
				{ json: line(2), pairedItem: { item: 0 } },
			]);
		});

		it('with Return All, pages with ?after= from nextAfter until it is null', async () => {
			const pages = [
				{ ...drained, lines: [line(1), line(2)], nextAfter: 2 },
				{ ...drained, lines: [line(5)], nextAfter: 5 },
				{ ...drained, lines: [line(9)], nextAfter: null },
			];
			const httpRequest = vi.fn(async () => pages.shift());
			const { calls, out } = await run({ params: { ...params, returnAll: true }, httpRequest });
			expect(calls.map((c) => c.qs)).toEqual([{}, { after: 2 }, { after: 5 }]);
			expect(out.map((o) => o.json.number)).toEqual([1, 2, 5, 9]);
		});

		it('stops at Limit, reading no further page than it needs', async () => {
			const pages = [
				{ ...drained, lines: [line(1), line(2)], nextAfter: 2 },
				{ ...drained, lines: [line(3), line(4)], nextAfter: 4 },
				{ ...drained, lines: [line(5)], nextAfter: null },
			];
			const httpRequest = vi.fn(async () => pages.shift());
			const { calls, out } = await run({ params: { ...params, limit: 3 }, httpRequest });
			expect(calls).toHaveLength(2);
			expect(out.map((o) => o.json.number)).toEqual([1, 2, 3]);
		});

		it('outputs nothing for an artifact with no lines yet', async () => {
			const httpRequest = vi.fn(async () => ({ id, source: 'pim', state: 'reserved' }));
			const { out } = await run({ params, httpRequest });
			expect(out).toEqual([]);
		});
	});

	describe('refusals (Ingest artifact spec: problem details)', () => {
		const ops = [
			['Get', { operation: 'get', artifactId: id }],
			['Get Many', { operation: 'getMany', returnAll: false, limit: 50, state: '' }],
			['Get Lines', { operation: 'getLines', artifactId: id, returnAll: false, limit: 50 }],
		] as const;

		it.each(ops)('%s names an unknown source or artifact as not-found', async (_, params) => {
			const httpRequest = vi.fn(async () => {
				throw refusal(404, 'not-found', 'No such source.', 'No source pim in this environment.');
			});
			await expect(run({ params, httpRequest })).rejects.toMatchObject({
				message: 'No such source. (not-found)',
				description: 'No source pim in this environment.',
			});
		});

		it('Get Many names an invalid State or cursor as invalid-listing', async () => {
			const httpRequest = vi.fn(async () => {
				throw refusal(400, 'invalid-listing', 'The listing is not valid.', 'cursor is not one a listing answers. Start again without it.');
			});
			await expect(run({ params: ops[1][1], httpRequest })).rejects.toMatchObject({
				message: 'The listing is not valid. (invalid-listing)',
			});
		});

		it.each(ops)('%s names a missing key (401) and a key without write scope (403)', async (_, params) => {
			for (const [status, message] of [
				[401, 'The API key was rejected by the Ingest URL.'],
				[403, "The API key isn't allowed to write to this Context Graph."],
			] as const) {
				const httpRequest = vi.fn(async () => {
					throw n8nFailure(status);
				});
				await expect(run({ params, httpRequest })).rejects.toMatchObject({ message, httpCode: String(status) });
			}
		});

		it('with Continue On Fail, outputs { source, id, error, description } and goes on with the next item', async () => {
			const httpRequest = vi.fn(async (req: IHttpRequestOptions) => {
				if (req.url.endsWith('-000000000000')) throw refusal(404, 'not-found', 'No such artifact.', 'No artifact with this id under pim.');
				return drained;
			});
			const { out } = await run({
				params: { operation: 'get', artifactId: (i: number) => `00000000-0000-0000-0000-00000000000${i}` },
				httpRequest,
				items: 2,
				continueOnFail: true,
			});
			expect(out).toEqual([
				{
					json: {
						source: 'pim',
						id: '00000000-0000-0000-0000-000000000000',
						error: 'No such artifact. (not-found)',
						description: 'No artifact with this id under pim.',
					},
					pairedItem: { item: 0 },
				},
				{ json: drained, pairedItem: { item: 1 } },
			]);
		});

		it('with Continue On Fail, Get Many outputs { source, error } without an id', async () => {
			const httpRequest = vi.fn(async () => {
				throw n8nFailure(401);
			});
			const { out } = await run({ params: ops[1][1], httpRequest, continueOnFail: true });
			expect(out).toEqual([
				{ json: { source: 'pim', error: 'The API key was rejected by the Ingest URL.' }, pairedItem: { item: 0 } },
			]);
		});
	});
});

describe('EnterspeedContextGraph — Artifact reads: Continue On Fail and IDs', () => {
	const id = '0b8a3c2e-6f51-4d0a-9a4e-3f1c2b7d9e10';
	const artifact = { id, source: 'pim', state: 'drained' };

	it('keeps going when Source is an expression that throws, with Continue On Fail on', async () => {
		const httpRequest = vi.fn(async () => artifact);
		const ctx = createContextGraphExecuteMock({
			params: {
				resource: 'artifact',
				operation: 'get',
				artifactId: id,
				sourceAlias: (i: number) => {
					if (i === 0) throw new Error("Cannot read properties of undefined (reading 'b')");
					return 'pim';
				},
			},
			items: [{}, {}],
			httpRequest,
			continueOnFail: true,
		});
		const [out] = (await node.execute.call(ctx)) as INodeExecutionData[][];
		expect(out).toEqual([
			{ json: { error: "Cannot read properties of undefined (reading 'b')", id }, pairedItem: { item: 0 } },
			{ json: artifact, pairedItem: { item: 1 } },
		]);
	});

	it.each(['get', 'getLines'])('%s fails an Artifact ID that is not a GUID before anything is sent', async (operation) => {
		const httpRequest = vi.fn();
		const ctx = createContextGraphExecuteMock({
			params: { resource: 'artifact', operation, sourceAlias: 'pim', artifactId: 'P-81', returnAll: true },
			httpRequest,
		});
		await expect(node.execute.call(ctx)).rejects.toMatchObject({
			message: 'Item 0 has an Artifact ID that is not an artifact ID (a GUID).',
		});
		expect(httpRequest).not.toHaveBeenCalled();
	});
});
