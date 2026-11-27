import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IDataObject, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { EnterspeedContextGraphTrigger } from '../nodes/EnterspeedContextGraph/EnterspeedContextGraphTrigger.node';
import {
	sign,
	signingKey,
	verifySignature,
} from '../nodes/EnterspeedContextGraph/webhookTrigger/signature';

/**
 * The fixtures are semantic-graph's own vectors, copied verbatim from
 * `contracts/vectors/webhook-signature/` and `contracts/vectors/outbound-envelope/`.
 * Every secret in them is a published test value, never used for anything real.
 */

interface SignatureVector {
	description: string;
	input: {
		secret: string;
		previousSecret?: string;
		id: string;
		timestamp: number;
		body?: string;
		bodyBase64?: string;
	};
	expected: { 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string };
}

interface EnvelopeVector {
	description: string;
	input: IDataObject;
	expected: IDataObject;
}

const FIXTURES = join(__dirname, 'fixtures');

function load<T>(family: string): Array<[string, T]> {
	const dir = join(FIXTURES, family);
	return readdirSync(dir)
		.filter((file) => file.endsWith('.json'))
		.map((file) => [file, JSON.parse(readFileSync(join(dir, file), 'utf-8')) as T]);
}

const signatureVectors = load<SignatureVector>('webhook-signature');
const envelopeVectors = load<EnvelopeVector>('outbound-envelope');
const golden = signatureVectors.find(([file]) => file === 'golden-overlap-two-signatures.json')![1];

const bodyOf = (input: SignatureVector['input']) =>
	input.bodyBase64 !== undefined
		? Buffer.from(input.bodyBase64, 'base64')
		: Buffer.from(input.body!, 'utf-8');

const GOLDEN_SECRET = golden.input.secret;
const GOLDEN_PREVIOUS = golden.input.previousSecret!;
const GOLDEN_BODY = bodyOf(golden.input);
const GOLDEN_TIME = golden.input.timestamp;

const node = new EnterspeedContextGraphTrigger();

function run(opts: {
	body: Buffer;
	headers: IDataObject;
	creds?: IDataObject;
	params?: IDataObject;
	rawBodyLate?: boolean;
}) {
	const response: { status?: number; body?: unknown } = {};
	const request: { rawBody?: Buffer; readRawBody?: () => Promise<void> } = opts.rawBodyLate
		? {
				readRawBody: async () => {
					request.rawBody = opts.body;
				},
			}
		: { rawBody: opts.body };
	const getCredentials = vi.fn(async () => ({ signingSecret: GOLDEN_SECRET, ...opts.creds }));
	const ctx = {
		getCredentials,
		getNodeParameter: (name: string, fallback?: unknown) =>
			opts.params && name in opts.params ? opts.params[name] : fallback,
		getNode: () => ({ name: 'Enterspeed Context Graph Trigger' }),
		getHeaderData: () => opts.headers,
		getRequestObject: () => request,
		getBodyData: () => {
			throw new Error('the trigger must verify the raw body, not the parsed one');
		},
		getResponseObject: () => ({
			status: (code: number) => {
				response.status = code;
				return {
					send: (b: unknown) => {
						response.body = b;
					},
				};
			},
		}),
		helpers: { returnJsonArray: (data: IDataObject[]) => data.map((json) => ({ json })) },
	} as unknown as IWebhookFunctions;
	return {
		promise: node.webhook.call(ctx) as Promise<IWebhookResponseData>,
		response,
		getCredentials,
	};
}

/** Headers for a body signed now (or at `at`) with the given secrets. */
function signed(
	body: Buffer,
	opts: { secrets?: string[]; id?: string; at?: number } = {},
): IDataObject {
	const id = opts.id ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
	const timestamp = String(opts.at ?? Math.floor(Date.now() / 1000));
	const signature = (opts.secrets ?? [GOLDEN_SECRET])
		.map((s) => sign(signingKey(s)!, id, timestamp, body))
		.join(' ');
	return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature };
}

function goldenHeaders(signature = golden.expected['webhook-signature']): IDataObject {
	return {
		'webhook-id': golden.expected['webhook-id'],
		'webhook-timestamp': golden.expected['webhook-timestamp'],
		'webhook-signature': signature,
	};
}

describe('webhook signature (semantic-graph vectors)', () => {
	it.each(signatureVectors)('%s: reproduces the expected signature', (_file, vector) => {
		const { input, expected } = vector;
		const body = bodyOf(input);
		const timestamp = String(input.timestamp);
		const secrets = [input.secret, ...(input.previousSecret ? [input.previousSecret] : [])];
		const signature = secrets.map((s) => sign(signingKey(s)!, input.id, timestamp, body)).join(' ');
		expect(signature).toBe(expected['webhook-signature']);
	});

	it.each(signatureVectors)('%s: verifies with the current secret', (_file, vector) => {
		const { input, expected } = vector;
		const headers = {
			id: expected['webhook-id'],
			timestamp: expected['webhook-timestamp'],
			signature: expected['webhook-signature'],
		};
		expect(verifySignature(input.secret, headers, bodyOf(input), input.timestamp)).toBeUndefined();
	});

	it('verifies an overlap delivery with the previous secret alone', () => {
		const headers = {
			id: golden.input.id,
			timestamp: String(GOLDEN_TIME),
			signature: golden.expected['webhook-signature'],
		};
		expect(verifySignature(GOLDEN_PREVIOUS, headers, GOLDEN_BODY, GOLDEN_TIME)).toBeUndefined();
	});

	it('refuses the escaped body signature over the raw UTF-8 body (no re-serialising)', () => {
		const escaped = signatureVectors.find(([f]) => f === 'escaped-body-is-signed-as-sent.json')![1];
		const raw = signatureVectors.find(([f]) => f === 'body-bytes-are-signed-as-sent.json')![1];
		const headers = {
			id: escaped.expected['webhook-id'],
			timestamp: escaped.expected['webhook-timestamp'],
			signature: escaped.expected['webhook-signature'],
		};
		expect(
			verifySignature(escaped.input.secret, headers, bodyOf(raw.input), escaped.input.timestamp),
		).toBe('no-matching-signature');
	});

	it('accepts the secret without its whsec_ prefix, as the libraries do', () => {
		const headers = {
			id: golden.input.id,
			timestamp: String(GOLDEN_TIME),
			signature: golden.expected['webhook-signature'],
		};
		expect(
			verifySignature(GOLDEN_SECRET.slice('whsec_'.length), headers, GOLDEN_BODY, GOLDEN_TIME),
		).toBeUndefined();
	});

	it('never uses the secret string itself as the key', () => {
		const wrong = `v1,${createHmac('sha256', GOLDEN_SECRET)
			.update(`${golden.input.id}.${GOLDEN_TIME}.`)
			.update(GOLDEN_BODY)
			.digest('base64')}`;
		const headers = { id: golden.input.id, timestamp: String(GOLDEN_TIME), signature: wrong };
		expect(verifySignature(GOLDEN_SECRET, headers, GOLDEN_BODY, GOLDEN_TIME)).toBe(
			'no-matching-signature',
		);
	});

	it.each([
		[
			'a missing header',
			{ id: golden.input.id, timestamp: String(GOLDEN_TIME), signature: undefined },
			'missing-headers',
		],
		[
			'a non-numeric timestamp',
			{ id: golden.input.id, timestamp: '17932608OO', signature: 'v1,x' },
			'invalid-timestamp',
		],
		[
			'an unknown signature version only',
			{
				id: golden.input.id,
				timestamp: String(GOLDEN_TIME),
				signature: 'v1a,TYdsEr1hCGSn+rGiexWyhDwI7xoRwcHqboiXF0YQafM=',
			},
			'no-matching-signature',
		],
	])('refuses %s', (_name, headers, failure) => {
		expect(verifySignature(GOLDEN_SECRET, headers, GOLDEN_BODY, GOLDEN_TIME)).toBe(failure);
	});

	it('refuses a secret that is not base64', () => {
		const headers = {
			id: golden.input.id,
			timestamp: String(GOLDEN_TIME),
			signature: golden.expected['webhook-signature'],
		};
		expect(verifySignature('whsec_not base64!', headers, GOLDEN_BODY, GOLDEN_TIME)).toBe(
			'invalid-secret',
		);
		expect(verifySignature('', headers, GOLDEN_BODY, GOLDEN_TIME)).toBe('invalid-secret');
	});

	it('honours a five-minute tolerance either side', () => {
		const headers = {
			id: golden.input.id,
			timestamp: String(GOLDEN_TIME),
			signature: golden.expected['webhook-signature'],
		};
		expect(verifySignature(GOLDEN_SECRET, headers, GOLDEN_BODY, GOLDEN_TIME + 300)).toBeUndefined();
		expect(verifySignature(GOLDEN_SECRET, headers, GOLDEN_BODY, GOLDEN_TIME - 300)).toBeUndefined();
		expect(verifySignature(GOLDEN_SECRET, headers, GOLDEN_BODY, GOLDEN_TIME + 301)).toBe(
			'timestamp-out-of-tolerance',
		);
		expect(verifySignature(GOLDEN_SECRET, headers, GOLDEN_BODY, GOLDEN_TIME - 301)).toBe(
			'timestamp-out-of-tolerance',
		);
	});
});

describe('EnterspeedContextGraphTrigger.webhook', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(GOLDEN_TIME * 1000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('answers the golden delivery with one item per changed entry, plus type, environmentId and deliveryId', async () => {
		const { promise, response, getCredentials } = run({
			body: GOLDEN_BODY,
			headers: goldenHeaders(),
		});
		const result = await promise;
		expect(getCredentials).toHaveBeenCalledWith('enterspeedContextGraphWebhookApi');
		expect(response.status).toBeUndefined();
		const envelope = JSON.parse(GOLDEN_BODY.toString('utf-8'));
		expect(result.workflowData).toHaveLength(1);
		expect(result.workflowData![0].map((item) => item.json)).toEqual(
			envelope.tags.map((tag: IDataObject) => ({
				...tag,
				type: 'model-changed',
				environmentId: envelope.environmentId,
				deliveryId: envelope.deliveryId,
			})),
		);
		// A null hash stays null, never dropped.
		expect(result.workflowData![0][1].json).toHaveProperty('hash', null);
	});

	it('starts a run for a two-signature delivery when only the previous secret is in the credential', async () => {
		const { promise } = run({
			body: GOLDEN_BODY,
			headers: goldenHeaders(),
			creds: { signingSecret: GOLDEN_PREVIOUS },
		});
		expect((await promise).workflowData?.[0]).toHaveLength(3);
	});

	it('reads the raw body when n8n has not loaded it yet', async () => {
		const { promise } = run({ body: GOLDEN_BODY, headers: goldenHeaders(), rawBodyLate: true });
		expect((await promise).workflowData?.[0]).toHaveLength(3);
	});

	it.each([
		['a wrong signature', () => goldenHeaders('v1,RvNdzpFvn4fr+yLreUbPGvkRP8T1AvXIEILqbHXCY20=')],
		['no signature headers', () => ({})],
		[
			'a signature from another secret',
			() => signed(GOLDEN_BODY, { secrets: [GOLDEN_PREVIOUS], at: GOLDEN_TIME }),
		],
	])('rejects %s with 401 and starts no run', async (_name, headers) => {
		const { promise, response } = run({ body: GOLDEN_BODY, headers: headers() });
		const result = await promise;
		expect(response.status).toBe(401);
		expect(result).toEqual({ noWebhookResponse: true });
	});

	it('rejects a tampered body with 401', async () => {
		const tampered = Buffer.from(GOLDEN_BODY.toString('utf-8').replace('"deleted"', '"upserted"'));
		const { promise, response } = run({ body: tampered, headers: goldenHeaders() });
		expect(await promise).toEqual({ noWebhookResponse: true });
		expect(response.status).toBe(401);
	});

	it('rejects a correctly signed delivery outside the tolerance with 401', async () => {
		vi.setSystemTime((GOLDEN_TIME + 301) * 1000);
		const { promise, response } = run({ body: GOLDEN_BODY, headers: goldenHeaders() });
		expect(await promise).toEqual({ noWebhookResponse: true });
		expect(response.status).toBe(401);
		expect(String(response.body)).toContain('timestamp-out-of-tolerance');
	});

	it('never writes the secret into the rejection', async () => {
		const { promise, response } = run({ body: GOLDEN_BODY, headers: goldenHeaders('v1,AAAA') });
		await promise;
		expect(String(response.body)).not.toContain(GOLDEN_SECRET.slice('whsec_'.length));
	});

	it('rejects a missing raw body with 401', async () => {
		const { promise, response } = run({
			body: undefined as unknown as Buffer,
			headers: goldenHeaders(),
		});
		expect(await promise).toEqual({ noWebhookResponse: true });
		expect(response.status).toBe(401);
	});

	describe('receiver header', () => {
		const creds = { receiverHeaderName: 'X-Api-Key', receiverHeaderSecret: 'made-up-value' };

		it('passes when the header matches (names are case-insensitive)', async () => {
			const { promise } = run({
				body: GOLDEN_BODY,
				headers: { ...goldenHeaders(), 'x-api-key': 'made-up-value' },
				creds,
			});
			expect((await promise).workflowData?.[0]).toHaveLength(3);
		});

		it.each([
			['missing', {}],
			['wrong', { 'x-api-key': 'other-value' }],
		])('rejects a %s header with 401 even when the signature verifies', async (_name, extra) => {
			const { promise, response } = run({
				body: GOLDEN_BODY,
				headers: { ...goldenHeaders(), ...extra },
				creds,
			});
			expect(await promise).toEqual({ noWebhookResponse: true });
			expect(response.status).toBe(401);
		});

		it('is not checked when no header name is set', async () => {
			const { promise } = run({
				body: GOLDEN_BODY,
				headers: goldenHeaders(),
				creds: { receiverHeaderSecret: 'ignored' },
			});
			expect((await promise).workflowData?.[0]).toHaveLength(3);
		});
	});

	describe('event types', () => {
		it('acknowledges an unselected type and starts no run', async () => {
			const body = Buffer.from(
				GOLDEN_BODY.toString('utf-8').replace('model-changed', 'something-new'),
			);
			const { promise, response } = run({
				body,
				headers: signed(body),
				params: { eventTypes: ['model-changed'] },
			});
			expect(await promise).toEqual({});
			expect(response.status).toBeUndefined();
		});

		it('starts on a selected type', async () => {
			const { promise } = run({
				body: GOLDEN_BODY,
				headers: goldenHeaders(),
				params: { eventTypes: ['model-changed'] },
			});
			expect((await promise).workflowData?.[0]).toHaveLength(3);
		});

		it('starts on an unknown type and keeps unknown properties when no type is chosen', async () => {
			const body = Buffer.from(
				JSON.stringify({
					type: 'something-new',
					environmentId: '11111111-2222-3333-4444-555555555555',
					deliveryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
					extra: { added: true },
					tags: [{ key: 'm1:shape:a:id:1', hash: null, action: 'deleted', reason: 'later field' }],
				}),
			);
			const { promise } = run({ body, headers: signed(body) });
			expect((await promise).workflowData?.[0][0].json).toEqual({
				key: 'm1:shape:a:id:1',
				hash: null,
				action: 'deleted',
				reason: 'later field',
				extra: { added: true },
				type: 'something-new',
				environmentId: '11111111-2222-3333-4444-555555555555',
				deliveryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
			});
		});
	});

	it('shows a redelivery (same webhook-id, new timestamp) with the same deliveryId', async () => {
		vi.setSystemTime((GOLDEN_TIME + 60) * 1000);
		const { promise } = run({
			body: GOLDEN_BODY,
			headers: signed(GOLDEN_BODY, { at: GOLDEN_TIME + 60 }),
		});
		const items = (await promise).workflowData![0];
		expect(
			items.every((item) => item.json.deliveryId === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
		).toBe(true);
	});

	it('answers 400 for a verified body that is not an envelope, and starts no run', async () => {
		for (const text of ['not json', '{"type":"model-changed"}', 'null']) {
			const body = Buffer.from(text);
			const { promise, response } = run({ body, headers: signed(body) });
			expect(await promise).toEqual({ noWebhookResponse: true });
			expect(response.status).toBe(400);
		}
	});

	it('starts no run for an envelope with no entries', async () => {
		const body = Buffer.from('{"type":"model-changed","tags":[]}');
		const { promise } = run({ body, headers: signed(body) });
		expect(await promise).toEqual({});
	});

	it.each(envelopeVectors)(
		'%s: outputs each tag of the vector envelope unchanged',
		async (_file, vector) => {
			const body = Buffer.from(JSON.stringify(vector.expected));
			const { promise } = run({ body, headers: signed(body) });
			const items = (await promise).workflowData![0].map((item) => item.json);
			const expected = vector.expected;
			expect(items).toEqual(
				(expected.tags as IDataObject[]).map((tag) => ({
					...tag,
					type: expected.type,
					environmentId: expected.environmentId,
					deliveryId: expected.deliveryId,
				})),
			);
		},
	);

	it('verifies the escaped bytes of a non-ASCII envelope, as the sender posts them', async () => {
		const vector = envelopeVectors.find(([f]) => f === 'non-ascii-tag-key-round-trips.json')![1];
		// The sender escapes non-ASCII and HTML-sensitive characters.
		const escaped = JSON.stringify(vector.expected).replace(
			/[^\x20-\x7e]|[&<>]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
		);
		const body = Buffer.from(escaped, 'utf-8');
		const { promise } = run({ body, headers: signed(body) });
		const [item] = (await promise).workflowData![0];
		expect(item.json.key).toBe('m1:index-bucket:products:brand=Ægir & Søn');
	});
});

describe('EnterspeedContextGraphTrigger description', () => {
	it('answers on receipt and uses its own credential', () => {
		expect(node.description.webhooks?.[0]).toMatchObject({
			httpMethod: 'POST',
			responseMode: 'onReceived',
		});
		expect(node.description.credentials).toEqual([
			{
				name: 'enterspeedContextGraphWebhookApi',
				required: true,
				testedBy: 'enterspeedContextGraphWebhookTest',
			},
		]);
	});
});

describe('EnterspeedContextGraphTrigger credential test', () => {
	const test = (data: IDataObject) =>
		node.methods.credentialTest.enterspeedContextGraphWebhookTest.call(
			{} as never,
			{ id: '1', name: 'c', type: 'enterspeedContextGraphWebhookApi', data } as never,
		);

	it('passes a signing secret', async () => {
		expect(await test({ signingSecret: GOLDEN_SECRET })).toMatchObject({ status: 'OK' });
	});

	it.each([
		['an empty secret', { signingSecret: '' }],
		['a secret that is not base64', { signingSecret: 'whsec_not base64!' }],
		[
			'a secret under 24 bytes',
			{ signingSecret: `whsec_${Buffer.alloc(23, 1).toString('base64')}` },
		],
		[
			'a header name without a value',
			{ signingSecret: GOLDEN_SECRET, receiverHeaderName: 'X-Api-Key' },
		],
	])('fails %s', async (_name, data) => {
		expect(await test(data)).toMatchObject({ status: 'Error' });
	});
});
