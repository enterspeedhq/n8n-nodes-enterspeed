import { describe, it, expect } from 'vitest';
import type { IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { EnterspeedContextGraph } from '../nodes/EnterspeedContextGraph/EnterspeedContextGraph.node';
import { EnterspeedContextGraphApi } from '../credentials/EnterspeedContextGraphApi.credentials';

/**
 * The Context Graph node ships with no operations yet: it must only accept
 * its own credential and refuse to run. The credential must mask the key,
 * send it only as a header, and test against a read-only Delivery route.
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
