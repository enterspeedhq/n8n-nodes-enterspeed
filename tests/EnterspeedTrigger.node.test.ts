import { describe, it, expect, vi } from 'vitest';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import { EnterspeedTrigger } from '../nodes/Enterspeed/EnterspeedTrigger.node';
import { createPollMock, defaultCreds } from './mocks';

/**
 * The trigger polls the Query API and emits only items that are new or changed
 * since the last poll. State lives in `staticData`, which we pass as a live
 * object so it carries across successive poll() calls.
 */

const node = new EnterspeedTrigger();
const baseParams = {
	indexAlias: 'productIndex',
	markerField: 'updatedAt',
	idField: 'id',
	emitOnFirst: false,
	queryBody: { pagination: { page: 1, size: 200 } },
};

function poll(opts: {
	results: IDataObject[];
	staticData: IDataObject;
	params?: Record<string, unknown>;
}) {
	const httpRequest = vi.fn(async () => ({ results: opts.results }));
	const { ctx } = createPollMock({
		params: { ...baseParams, ...opts.params },
		creds: defaultCreds,
		httpRequest,
		staticData: opts.staticData,
	});
	return { promise: node.poll.call(ctx), httpRequest };
}

describe('EnterspeedTrigger.poll', () => {
	it('first run sets a baseline and emits nothing (emitOnFirst=false)', async () => {
		const staticData: IDataObject = {};
		const { promise } = poll({ results: [{ id: '1', updatedAt: 'a' }], staticData });
		expect(await promise).toBeNull();
		expect(staticData.seen).toEqual({ '1': 'a' });
		expect(staticData.initialised).toBe(true);
	});

	it('first run emits all current items when emitOnFirst=true', async () => {
		const staticData: IDataObject = {};
		const { promise } = poll({
			results: [{ id: '1', updatedAt: 'a' }, { id: '2', updatedAt: 'b' }],
			staticData,
			params: { emitOnFirst: true },
		});
		const out = (await promise) as INodeExecutionData[][];
		expect(out[0]).toHaveLength(2);
	});

	it('emits only the changed item on a subsequent poll', async () => {
		const staticData: IDataObject = { seen: { '1': 'a', '2': 'b' }, initialised: true };
		const { promise } = poll({
			results: [
				{ id: '1', updatedAt: 'a' }, // unchanged
				{ id: '2', updatedAt: 'b2' }, // changed marker
			],
			staticData,
		});
		const out = (await promise) as INodeExecutionData[][];
		expect(out[0]).toHaveLength(1);
		expect(out[0][0].json).toMatchObject({ id: '2', updatedAt: 'b2' });
	});

	it('emits a brand-new item that was not seen before', async () => {
		const staticData: IDataObject = { seen: { '1': 'a' }, initialised: true };
		const { promise } = poll({
			results: [{ id: '1', updatedAt: 'a' }, { id: '3', updatedAt: 'c' }],
			staticData,
		});
		const out = (await promise) as INodeExecutionData[][];
		expect(out[0]).toHaveLength(1);
		expect(out[0][0].json).toMatchObject({ id: '3' });
	});

	it('returns null when nothing changed', async () => {
		const staticData: IDataObject = { seen: { '1': 'a' }, initialised: true };
		const { promise } = poll({ results: [{ id: '1', updatedAt: 'a' }], staticData });
		expect(await promise).toBeNull();
	});

	it('falls back to hashing the whole item when the marker field is absent', async () => {
		const staticData: IDataObject = { seen: { '1': JSON.stringify({ id: '1', v: 1 }) }, initialised: true };
		const { promise } = poll({
			results: [{ id: '1', v: 2 }],
			staticData,
			params: { markerField: 'updatedAt' }, // field not present on the item
		});
		const out = (await promise) as INodeExecutionData[][];
		expect(out[0]).toHaveLength(1);
		expect(out[0][0].json).toMatchObject({ id: '1', v: 2 });
	});
});
