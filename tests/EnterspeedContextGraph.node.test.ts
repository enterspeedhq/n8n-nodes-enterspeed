import { describe, it, expect } from 'vitest';
import type { ICredentialDataDecryptedObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { EnterspeedContextGraph } from '../nodes/EnterspeedContextGraph/EnterspeedContextGraph.node';
import { EnterspeedContextGraphApi } from '../credentials/EnterspeedContextGraphApi.credentials';

/**
 * The Context Graph node ships with no operations yet: it must only accept
 * its own credential and refuse to run. The credential must mask both keys,
 * send each only to its own service as a header, and test against a read-only Delivery route.
 */

const node = new EnterspeedContextGraph();
const credential = new EnterspeedContextGraphApi();

describe('EnterspeedContextGraph node', () => {
	it('accepts only the Context Graph credential, never the Core one', () => {
		expect(node.description.credentials).toEqual([
			{ name: 'enterspeedContextGraphApi', required: true },
		]);
	});

	it('refuses to run, since it has no operations yet', async () => {
		const ctx = { getNode: () => ({ name: 'Enterspeed Context Graph' }) } as unknown as IExecuteFunctions;
		await expect(node.execute.call(ctx)).rejects.toThrow(NodeOperationError);
		await expect(node.execute.call(ctx)).rejects.toThrow(/no operations yet/);
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
			expect(await header('https://ingest.example.com/entities')).toEqual({ a: 'b', 'X-Api-Key': 'ingest-key' });
			expect(await header('https://ingest.example.com')).toEqual({ a: 'b', 'X-Api-Key': 'ingest-key' });
		});

		it('the Delivery API Key everywhere else', async () => {
			expect(await header('https://delivery.example.com/schema/msd/v1/1.0.0')).toEqual({ a: 'b', 'X-Api-Key': 'delivery-key' });
			// a host that only starts with the ingest URL isn't under it
			expect(await header('https://ingest.example.com.evil/entities')).toEqual({ a: 'b', 'X-Api-Key': 'delivery-key' });
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
