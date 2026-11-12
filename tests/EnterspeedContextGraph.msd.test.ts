import { describe, it, expect, vi } from 'vitest';
import type { IDataObject, ILoadOptionsFunctions } from 'n8n-workflow';
import {
	getIndexes,
	getFilterFields,
	getRepresentations,
	getRouteValues,
	getSchemaShapes,
	msdFilterOperators,
	msdIndexes,
	msdQueryLimits,
	msdRepresentations,
	NO_SHAPES,
	representationFields,
} from '../nodes/EnterspeedContextGraph/actions/schema/msd';
import {
	buildSchemaRequest,
	execute as getRepresentation,
} from '../nodes/EnterspeedContextGraph/actions/representation/get.operation';
import { builderQuery, execute as runQuery } from '../nodes/EnterspeedContextGraph/actions/index/query.operation';
import { execute as getShapes } from '../nodes/EnterspeedContextGraph/actions/shape/getMany.operation';
import { createContextGraphExecuteMock, defaultContextGraphCreds } from './mocks';

/**
 * An MSD as delivery's MaterialisedSchemaBuilder writes it (delivery/ADR-028
 * §4): root `filterOperators` and `queryLimits`, `indexes` keyed by name with
 * their field classification, and `representations[]` with `$name`,
 * `$routes`, `context` { required, optional, binders } and `slots`.
 */
const msd = {
	apiVersion: 1,
	manifestVersion: '1.0.0',
	filterOperators: ['contains', 'equals', 'greaterthan', 'in'],
	queryLimits: { default: 20, max: 100 },
	representations: [
		{
			$name: 'ProductPage',
			$routes: ['/products/{productId}', '/sku/{sku:alpha}'],
			context: {
				required: ['locale', 'productId', 'sku'],
				optional: ['preview'],
				binders: {
					locale: { source: 'header', key: 'X-Locale', type: 'string' },
					q: { source: 'query', key: 'search', type: 'string' },
					preview: { source: 'query', type: 'boolean' },
				},
			},
			slots: {
				product: { $type: 'shape', schema: {} },
				related: { $type: 'query', index: 'ProductIndex', items: {} },
			},
		},
	],
	indexes: {
		ProductIndex: {
			textFields: ['name'],
			keywordFields: ['sku', 'categoryId'],
			numericFields: ['price'],
			booleanFields: ['inStock'],
		},
	},
};

const ctxCreds = { ingestUrl: 'http://localhost:5200', deliveryUrl: 'http://localhost:5200', manifestVersion: '1.0.0' };

const loadOptions = (answer: () => Promise<unknown>, params: IDataObject = {}) => {
	const httpRequest = vi.fn(async (options: IDataObject) => (void options, answer()));
	const context = {
		getCredentials: async () => ({ ...defaultContextGraphCreds, deliveryUrl: 'http://localhost:5200/' }),
		getCurrentNodeParameter: (name: string) => params[name],
		getNode: () => ({ name: 'Enterspeed Context Graph' }),
		helpers: { httpRequestWithAuthentication: async (_c: string, options: IDataObject) => httpRequest(options) },
	} as unknown as ILoadOptionsFunctions;
	return { context, httpRequest };
};

describe('MSD reader', () => {
	it('reads representations, indexes, operators and limits as delivery writes them', () => {
		const [page] = msdRepresentations(msd);
		expect(page.name).toBe('ProductPage');
		expect(page.routes).toEqual(['/products/{productId}', '/sku/{sku:alpha}']);
		expect(page.binders.locale).toMatchObject({ source: 'header', key: 'X-Locale' });
		expect(page.slots).toEqual([
			{ name: 'product', type: 'shape', index: undefined },
			{ name: 'related', type: 'query', index: 'ProductIndex' },
		]);
		expect(msdIndexes(msd)[0]).toMatchObject({ name: 'ProductIndex', numericFields: ['price'] });
		expect(msdFilterOperators(msd)).toContain('equals');
		expect(msdQueryLimits(msd)).toEqual({ default: 20, max: 100 });
	});

	it('gives empty lists for a document that is not an MSD', () => {
		expect(msdRepresentations({ version: '1', modules: [] })).toEqual([]);
		expect(msdIndexes(undefined)).toEqual([]);
	});

	it("gives a route's context fields: its path values, then query and header values as the binders say", () => {
		const fields = representationFields(msdRepresentations(msd)[0], '/products/{productId}');
		expect(fields.map((f) => [f.id, f.required, f.type])).toEqual([
			['path:productId', true, 'string'],
			['header:X-Locale', true, 'string'],
			// Another route's placeholder is still read by a slot key, so it comes from the query string.
			['query:sku', true, 'string'],
			['query:preview', false, 'boolean'],
			['query:search', false, 'string'],
		]);
	});

	it('gives a route without placeholders every required key as a query value', () => {
		const representation = msdRepresentations({
			representations: [{ $name: 'p', $routes: ['product', 'product/{id}'], context: { required: ['id'] } }],
		})[0];
		expect(representationFields(representation, 'product').map((f) => [f.id, f.required])).toEqual([['query:id', true]]);
		expect(representationFields(representation, 'product/{id}').map((f) => f.id)).toEqual(['path:id']);
	});

	it("doesn't require a binder the caller may leave out", () => {
		const representation = msdRepresentations({
			representations: [
				{
					$name: 'p',
					$routes: ['p'],
					context: { required: ['locale'], binders: { locale: { source: 'query', presence: 'optional' } } },
				},
			],
		})[0];
		expect(representationFields(representation, 'p')[0]).toMatchObject({ id: 'query:locale', required: false });
	});

	it('reads the constrained placeholder name, without its constraint', () => {
		const fields = representationFields(msdRepresentations(msd)[0], '/sku/{sku:alpha}');
		expect(fields[0].id).toBe('path:sku');
	});
});

describe('MSD loadOptions', () => {
	it('reads GET {deliveryUrl}/schema/msd/v1/{manifest} with the API key and lists the representations', async () => {
		const { context, httpRequest } = loadOptions(async () => msd);
		const options = await getRepresentations.call(context);
		expect(httpRequest.mock.calls[0][0]).toMatchObject({
			method: 'GET',
			url: 'http://localhost:5200/schema/msd/v1/1.0.0',
		});
		expect(options.map((o) => o.value)).toEqual(['ProductPage']);
		expect(options[0].description).toContain('related (query on ProductIndex)');
	});

	it('lists the indexes and an index\'s filter fields with their value class', async () => {
		expect((await getIndexes.call(loadOptions(async () => msd).context)).map((o) => o.value)).toEqual(['ProductIndex']);
		const fields = await getFilterFields.call(loadOptions(async () => msd, { builderIndex: 'ProductIndex' }).context);
		expect(fields.map((o) => o.value)).toEqual(['keyword:sku', 'keyword:categoryId', 'numeric:price', 'boolean:inStock']);
	});

	it('gives the chosen route\'s values to the Context mapper', async () => {
		const { context } = loadOptions(async () => msd, { representation: 'ProductPage', representationRoute: '/products/{productId}' });
		expect((await getRouteValues.call(context)).fields[0].id).toBe('path:productId');
	});

	it("shows the Delivery service's reason when the schema can't be read", async () => {
		const rejected = loadOptions(async () => {
			throw { response: { status: 401 } };
		});
		await expect(getRepresentations.call(rejected.context)).rejects.toThrow('The API key was rejected');
		const unknown = loadOptions(async () => {
			throw { response: { status: 404, data: '"Manifest 9.9.9 is not hosted."' } };
		});
		await expect(getRepresentations.call(unknown.context)).rejects.toThrow('Manifest 9.9.9 is not hosted.');
	});

	it('says the schema lists no shapes, as the MSD lists none yet', async () => {
		await expect(getSchemaShapes.call(loadOptions(async () => msd).context)).rejects.toThrow(NO_SHAPES);
	});
});

describe('Representation › Get from the schema', () => {
	const fields = [
		{ id: 'path:productId', required: true },
		{ id: 'header:X-Locale', required: true },
		{ id: 'query:search', required: false },
	];

	it('fills the route and puts the other values in the query string and headers', () => {
		expect(
			buildSchemaRequest('/products/{productId}', { 'path:productId': 'p/1 001', 'header:X-Locale': 'da', 'query:search': '' }, fields),
		).toEqual({ segments: ['products', 'p/1 001'], qs: {}, headers: { 'X-Locale': 'da' } });
	});

	it('sends each path value as one percent-encoded segment', async () => {
		const httpRequest = vi.fn(async () => ({ product: {} }));
		const mock = createContextGraphExecuteMock({
			params: {
				routeFrom: 'schema',
				representationRoute: '/products/{productId}',
				'context.value': { 'path:productId': 'p/1001', 'header:X-Locale': 'da', 'query:search': 'red' },
				'context.schema': fields,
			},
			httpRequest,
		});
		await getRepresentation.call(mock, ctxCreds);
		expect(httpRequest.mock.calls[0][0]).toMatchObject({
			url: 'http://localhost:5200/v1/1.0.0/products/p%2F1001',
			qs: { search: 'red' },
			headers: { 'X-Locale': 'da' },
		});
	});

	it('fails the item without a request when a required value is empty', async () => {
		const httpRequest = vi.fn();
		const mock = createContextGraphExecuteMock({
			params: {
				routeFrom: 'schema',
				representationRoute: '/products/{productId}',
				'context.value': { 'path:productId': 'p-1001' },
				'context.schema': fields,
			},
			httpRequest,
		});
		await expect(getRepresentation.call(mock, ctxCreds)).rejects.toThrow('has no value for "X-Locale"');
		expect(httpRequest).not.toHaveBeenCalled();
	});
});

describe('Index › Query builder', () => {
	it('builds the /query wire form, each value in its field\'s value class (delivery/ADR-037)', () => {
		expect(
			builderQuery({
				index: 'ProductIndex',
				search: 'headphones',
				filters: [
					{ field: 'numeric:price', operator: 'lessThan', value: '3000' },
					{ field: 'boolean:inStock', operator: 'equals', value: 'true' },
					{ field: 'keyword:categoryId', operator: 'in', value: 'cat-a, cat-b' },
				],
				sort: [{ field: 'numeric:price', order: 'desc' }],
				limit: 20,
				page: 0,
			}),
		).toEqual({
			index: 'ProductIndex',
			search: { query: 'headphones' },
			filters: {
				and: [
					{ field: 'price', operator: 'lessThan', value: 3000 },
					{ field: 'inStock', operator: 'equals', value: true },
					{ field: 'categoryId', operator: 'in', value: ['cat-a', 'cat-b'] },
				],
			},
			sort: [{ field: 'price', direction: 'desc' }],
			limit: 20,
		});
	});

	it('sends a sort as direction asc or desc, reading an older saved Ascending/Descending the same (Query sort order contract)', () => {
		expect(
			builderQuery({
				index: 'I',
				sort: [{ field: 'numeric:price', order: 'Descending' }, { field: 'keyword:sku', order: 'Ascending' }, { field: 'keyword:name' }],
			}).sort,
		).toEqual([
			{ field: 'price', direction: 'desc' },
			{ field: 'sku', direction: 'asc' },
			{ field: 'name', direction: 'asc' },
		]);
	});

	it('sends one filter as itself, and leaves out what is empty', () => {
		expect(builderQuery({ index: 'I', filters: [{ field: 'keyword:sku', operator: 'equals', value: '42' }], id: 'a' })).toEqual({
			index: 'I',
			id: 'a',
			filters: { field: 'sku', operator: 'equals', value: '42' },
		});
	});

	it('sends every item\'s built query in one request', async () => {
		const httpRequest = vi.fn(async (req: IDataObject) =>
			(req.body as IDataObject[]).map((_q, i) => ({ id: String(i), items: [], totalCount: 0, next: null })),
		);
		const mock = createContextGraphExecuteMock({
			params: { queryFrom: 'builder', builderIndex: 'ProductIndex', queryLimit: 5 },
			items: [{}, {}],
			httpRequest,
		});
		const out = await runQuery.call(mock, ctxCreds);
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toEqual([
			{ index: 'ProductIndex', limit: 5 },
			{ index: 'ProductIndex', limit: 5 },
		]);
		expect(out.map((o) => o.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});
});

describe('Shape › Get Many from the schema', () => {
	it('builds one key per item and reads them all in one request, each result paired to its item', async () => {
		const httpRequest = vi.fn(async (req: IDataObject) =>
			((req.body as IDataObject).keys as string[]).map((key) => ({ key, status: 200, data: {} })),
		);
		const mock = createContextGraphExecuteMock({
			params: {
				keyFrom: 'schema',
				shapeName: 'ProductCard',
				'idSegments.value': (i: number) => ({ productId: `p-${i}` }),
				'idSegments.schema': [{ id: 'productId' }],
			},
			items: [{}, {}],
			httpRequest,
		});
		const out = await getShapes.call(mock, ctxCreds);
		expect(httpRequest).toHaveBeenCalledTimes(1);
		expect((httpRequest.mock.calls[0][0] as IDataObject).body).toEqual({
			keys: ['ProductCard:productId:p-0', 'ProductCard:productId:p-1'],
		});
		expect(out.map((o) => [o.json.key, o.pairedItem])).toEqual([
			['ProductCard:productId:p-0', { item: 0 }],
			['ProductCard:productId:p-1', { item: 1 }],
		]);
	});
});
