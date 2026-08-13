import type { IDataObject, INodeProperties } from 'n8n-workflow';

export const MAX_MULTI_QUERIES = 5;

/**
 * Fields shared by "Query Items" and each entry of "Multi Query Items".
 * `specifyQueryDefault` differs between the two: existing saved workflows for
 * the single-query operation have no stored value for `specifyQuery`, so its
 * default there must stay 'json' to preserve their current raw-body behavior.
 */
export function buildQueryFields(specifyQueryDefault: 'fields' | 'json'): INodeProperties[] {
	return [
		{
			displayName: 'Specify Query',
			name: 'specifyQuery',
			type: 'options',
			options: [
				{ name: 'Using Fields', value: 'fields' },
				{ name: 'Using JSON', value: 'json' },
			],
			default: specifyQueryDefault,
		},
		{
			displayName: 'Filters Combinator',
			name: 'filtersCombinator',
			type: 'options',
			options: [
				{ name: 'AND', value: 'and' },
				{ name: 'OR', value: 'or' },
			],
			default: 'and',
			displayOptions: { show: { specifyQuery: ['fields'] } },
			description:
				'How the filter conditions below are combined. For deeper nested AND/OR groups, use "Using JSON" instead.',
		},
		{
			displayName: 'Filters',
			name: 'filtersUi',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			placeholder: 'Add Filter',
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					name: 'condition',
					displayName: 'Condition',
					values: [
						{ displayName: 'Field', name: 'field', type: 'string', default: '' },
						{
							displayName: 'Operator',
							name: 'operator',
							type: 'options',
							options: [
								{ name: 'Contains', value: 'contains' },
								{ name: 'Equals', value: 'equals' },
								{ name: 'Greater Than', value: 'greaterThan' },
								{ name: 'Greater Than Or Equals', value: 'greaterThanOrEquals' },
								{ name: 'In', value: 'in' },
								{ name: 'Less Than', value: 'lessThan' },
								{ name: 'Less Than Or Equals', value: 'lessThanOrEquals' },
								{ name: 'Not Equals', value: 'notEquals' },
							],
							default: 'equals',
						},
						{
							displayName: 'Value',
							name: 'value',
							type: 'string',
							default: '',
							description: 'For "In", use a comma-separated list',
						},
						{
							displayName: 'Case Insensitive',
							name: 'caseInsensitive',
							type: 'boolean',
							default: false,
							description: 'Whether the filter value comparison ignores case',
						},
					],
				},
			],
		},
		{
			displayName: 'Sort',
			name: 'sortUi',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			placeholder: 'Add Sort Field',
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					name: 'item',
					displayName: 'Sort',
					values: [
						{ displayName: 'Field', name: 'field', type: 'string', default: '' },
						{
							displayName: 'Order',
							name: 'order',
							type: 'options',
							options: [
								{ name: 'Ascending', value: 'asc' },
								{ name: 'Descending', value: 'desc' },
							],
							default: 'desc',
						},
					],
				},
			],
		},
		{
			displayName: 'Facets',
			name: 'facetsUi',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			default: {},
			placeholder: 'Add Facet',
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					name: 'item',
					displayName: 'Facet',
					values: [
						{ displayName: 'Field', name: 'field', type: 'string', required: true, default: '' },
						{
							displayName: 'Name',
							name: 'name',
							type: 'string',
							default: '',
							description: 'Defaults to the field name',
						},
						{
							displayName: 'Size',
							name: 'size',
							type: 'number',
							default: 10,
							typeOptions: { minValue: 1, maxValue: 100 },
						},
					],
				},
			],
		},
		{
			displayName: 'Options',
			name: 'queryOptions',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			displayOptions: { show: { specifyQuery: ['fields'] } },
			options: [
				{
					displayName: 'Aliases',
					name: 'aliases',
					type: 'string',
					default: '',
					description: 'Comma-separated view aliases to include, e.g. productTile',
				},
				{
					displayName: 'Literal Match',
					name: 'searchLiteral',
					type: 'boolean',
					default: false,
					description: 'Whether the search value must match literally rather than being tokenized',
				},
				{
					displayName: 'Next Page Token',
					name: 'nextPageToken',
					type: 'string',
					typeOptions: { password: true },
					default: '',
				},
				{ displayName: 'Page', name: 'page', type: 'number', default: 0, typeOptions: { minValue: 0 } },
				{
					displayName: 'Page Size',
					name: 'pageSize',
					type: 'number',
					default: 10,
					typeOptions: { minValue: 1, maxValue: 1000 },
				},
				{ displayName: 'Search Field', name: 'searchField', type: 'string', default: '' },
				{ displayName: 'Search Value', name: 'searchValue', type: 'string', default: '' },
			],
		},
		{
			displayName: 'Query Body (JSON)',
			name: 'queryBody',
			type: 'json',
			default: '{\n  "pagination": { "page": 0, "size": 10 }\n}',
			displayOptions: { show: { specifyQuery: ['json'] } },
			description: 'Filters, sort, pagination and facets. All properties optional.',
		},
	];
}

/** Merges a resource/operation guard into each field's own displayOptions.show. */
export function withDisplayGuard(fields: INodeProperties[], guard: Record<string, string[]>): INodeProperties[] {
	return fields.map((field) => ({
		...field,
		displayOptions: {
			...field.displayOptions,
			show: { ...guard, ...(field.displayOptions?.show ?? {}) },
		},
	}));
}

/**
 * Assembles the Enterspeed Query API body from the structured "Using Fields"
 * parameters. Shared by the single Query Items operation and each entry of
 * Multi Query Items, since both expose the same field group.
 */
export function buildQueryPayload(fields: IDataObject): IDataObject {
	const body: IDataObject = {};

	const conditions = ((fields.filtersUi as IDataObject)?.condition as IDataObject[]) ?? [];
	if (conditions.length) {
		const combinator = (fields.filtersCombinator as string) === 'or' ? 'or' : 'and';
		body.filters = {
			[combinator]: conditions.map((c) => ({
				field: c.field,
				operator: c.operator,
				value: c.value,
				...(c.caseInsensitive ? { caseInsensitive: true } : {}),
			})),
		};
	}

	const sortItems = ((fields.sortUi as IDataObject)?.item as IDataObject[]) ?? [];
	if (sortItems.length) {
		body.sort = sortItems.map((s) => ({ field: s.field, order: s.order }));
	}

	const facetItems = ((fields.facetsUi as IDataObject)?.item as IDataObject[]) ?? [];
	if (facetItems.length) {
		body.facets = facetItems.map((f) => ({
			field: f.field,
			...(f.name ? { name: f.name } : {}),
			size: f.size,
		}));
	}

	const options = (fields.queryOptions as IDataObject) ?? {};
	if (options.searchField) {
		body.search = {
			field: options.searchField,
			value: options.searchValue,
			literal: Boolean(options.searchLiteral),
		};
	}

	const pagination: IDataObject = {};
	if (options.page !== undefined && options.page !== '') pagination.page = options.page;
	if (options.pageSize !== undefined && options.pageSize !== '') pagination.pageSize = options.pageSize;
	if (options.nextPageToken) pagination.nextPageToken = options.nextPageToken;
	if (Object.keys(pagination).length) body.pagination = pagination;

	if (options.aliases) {
		const aliases = (options.aliases as string)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		if (aliases.length) body.aliases = aliases;
	}

	return body;
}
