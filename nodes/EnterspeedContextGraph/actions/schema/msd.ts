import type {
	FieldType,
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';
import { API_VERSION } from '../shape/shared';

/*
 * The manifest's materialised schema document (MSD, delivery/ADR-028 §4), as
 * delivery's MaterialisedSchemaBuilder writes it. This file is the only code
 * that knows its form: everything below `read*` hands the rest of the node
 * plain lists. The schema is read while the node is edited, never in a run.
 */

/** A `query()` or `header()` binder declaration (contracts › spec › binder-constraint). */
export interface MsdBinder {
	source: 'query' | 'header';
	/** The query-string or header name; the context key when absent. */
	key?: string;
	type?: string;
	enum?: unknown[];
	array?: boolean;
	/** `optional` when the caller may leave it out. */
	presence?: string;
	hasDefault?: boolean;
}

export interface MsdSlot {
	name: string;
	/** `shape`, `query`, or a family the MSD doesn't model yet. */
	type: string;
	/** A query slot's index. */
	index?: string;
}

export interface MsdRepresentation {
	name: string;
	routes: string[];
	/** The caller-suppliable context keys a route or slot key can't resolve without. */
	required: string[];
	/** The caller-suppliable context keys only an `enabled` gate reads. */
	optional: string[];
	binders: Record<string, MsdBinder>;
	slots: MsdSlot[];
}

export interface MsdIndex {
	name: string;
	textFields: string[];
	keywordFields: string[];
	numericFields: string[];
	booleanFields: string[];
	/** The fields a query may sort on, in declaration order (empty when the index lists none). */
	sortableFields: string[];
}

export interface MsdQueryLimits {
	default?: number;
	max?: number;
}

/** An entry shape and its ID segments' keys, in key order. */
export interface MsdShape {
	name: string;
	segments: string[];
}

const isObject = (value: unknown): value is IDataObject =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function msdRepresentations(msd: unknown): MsdRepresentation[] {
	if (!isObject(msd) || !Array.isArray(msd.representations)) return [];
	return msd.representations.filter(isObject).flatMap((r) => {
		if (typeof r.$name !== 'string' || !r.$name) return [];
		const context = isObject(r.context) ? r.context : {};
		const binders: Record<string, MsdBinder> = {};
		for (const [key, b] of Object.entries(isObject(context.binders) ? context.binders : {})) {
			if (!isObject(b) || (b.source !== 'query' && b.source !== 'header')) continue;
			binders[key] = {
				source: b.source,
				key: typeof b.key === 'string' && b.key ? b.key : undefined,
				type: typeof b.type === 'string' ? b.type : undefined,
				enum: Array.isArray(b.enum) && b.enum.length ? b.enum : undefined,
				array: b.array === true,
				presence: typeof b.presence === 'string' ? b.presence : undefined,
				hasDefault: b.default !== undefined,
			};
		}
		const slots = Object.entries(isObject(r.slots) ? r.slots : {}).flatMap(([name, s]) =>
			isObject(s)
				? [{ name, type: typeof s.$type === 'string' ? s.$type : '', index: typeof s.index === 'string' ? s.index : undefined }]
				: [],
		);
		return [
			{
				name: r.$name,
				routes: strings(r.$routes),
				required: strings(context.required),
				optional: strings(context.optional),
				binders,
				slots,
			},
		];
	});
}

export function msdIndexes(msd: unknown): MsdIndex[] {
	if (!isObject(msd) || !isObject(msd.indexes)) return [];
	return Object.entries(msd.indexes).flatMap(([name, i]) =>
		isObject(i)
			? [
					{
						name,
						textFields: strings(i.textFields),
						keywordFields: strings(i.keywordFields),
						numericFields: strings(i.numericFields),
						booleanFields: strings(i.booleanFields),
						sortableFields: strings(i.sortableFields),
					},
				]
			: [],
	);
}

export const msdFilterOperators = (msd: unknown): string[] => (isObject(msd) ? strings(msd.filterOperators) : []);

export function msdQueryLimits(msd: unknown): MsdQueryLimits {
	const limits = isObject(msd) && isObject(msd.queryLimits) ? msd.queryLimits : {};
	return {
		default: typeof limits.default === 'number' ? limits.default : undefined,
		max: typeof limits.max === 'number' ? limits.max : undefined,
	};
}

/**
 * The entry shapes the MSD lists. It lists none yet (ADR-028 §4 has no entry
 * shapes or ID segments), so this is always empty: Shape's Schema mode waits
 * on the MSD, and this is the one place to change when it lists them.
 */
export function msdShapes(): MsdShape[] {
	return [];
}

/** A route template's segments: a literal, or a `{name[:constraint]}` placeholder (route-template contract). */
export type RouteSegment = { literal: string } | { placeholder: string };

export function routeSegments(template: string): RouteSegment[] {
	return template
		.split('/')
		.filter(Boolean)
		.map((segment) =>
			segment.length > 2 && segment.startsWith('{') && segment.endsWith('}')
				? { placeholder: segment.slice(1, -1).split(':')[0] }
				: { literal: segment },
		);
}

export const routePlaceholders = (template: string): string[] =>
	routeSegments(template).flatMap((s) => ('placeholder' in s ? [s.placeholder] : []));

/*
 * Where each context value goes, carried in its field's id so a run needs no
 * schema: `path:{placeholder}`, `query:{name}` or `header:{name}`. A route
 * placeholder fills its path segment. Every other caller-suppliable key goes
 * in the query string under its own name (delivery/ADR-036: every non-path
 * context entry is a query parameter), unless a binder names another key or
 * makes it a header.
 */
export type ContextTarget = 'path' | 'query' | 'header';

export const contextFieldId = (target: ContextTarget, name: string) => `${target}:${name}`;

export function parseContextFieldId(id: string): { target: ContextTarget; name: string } | undefined {
	const at = id.indexOf(':');
	const target = id.slice(0, at);
	if (at < 1 || (target !== 'path' && target !== 'query' && target !== 'header')) return undefined;
	return { target, name: id.slice(at + 1) };
}

const fieldType = (binder: MsdBinder | undefined): FieldType => {
	if (binder?.enum) return 'options';
	if (binder?.type === 'number' || binder?.type === 'integer') return 'number';
	if (binder?.type === 'boolean') return 'boolean';
	return 'string';
};

/** The context fields of one route of a representation, path values first. */
export function representationFields(representation: MsdRepresentation, route: string): ResourceMapperField[] {
	const placeholders = routePlaceholders(route);
	// Only this route's own placeholders fill the path. A key that is a placeholder
	// in another route is still read by a slot key here, so it comes from the
	// query string instead (a route without {id} still needs an id).
	const inRoute = new Set(placeholders.map((p) => p.toLowerCase()));
	const binderFor = (key: string) =>
		Object.entries(representation.binders).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];

	const fields: ResourceMapperField[] = placeholders.map((p) => ({
		id: contextFieldId('path', p),
		displayName: `${p} (path)`,
		required: true,
		defaultMatch: false,
		display: true,
		type: 'string',
	}));
	const contextField = (key: string, required: boolean): ResourceMapperField => {
		const binder = binderFor(key);
		const target: ContextTarget = binder?.source === 'header' ? 'header' : 'query';
		const name = binder?.key ?? key;
		return {
			id: contextFieldId(target, name),
			displayName: `${key} (${target}${name !== key ? `: ${name}` : ''})`,
			required,
			defaultMatch: false,
			display: true,
			type: fieldType(binder),
			...(binder?.enum && { options: binder.enum.map((v) => ({ name: String(v), value: String(v) })) }),
		};
	};
	const rest = (keys: string[]) => keys.filter((k) => !inRoute.has(k.toLowerCase()));
	// A binder the caller may leave out (presence optional, or a default) isn't required.
	const mayOmit = (key: string) => {
		const binder = binderFor(key);
		return binder?.presence === 'optional' || binder?.hasDefault === true;
	};
	fields.push(...rest(representation.required).map((k) => contextField(k, !mayOmit(k))));
	fields.push(...rest(representation.optional).map((k) => contextField(k, false)));
	// A binder that no route or slot key reads is still caller-suppliable.
	const listed = new Set([...representation.required, ...representation.optional].map((k) => k.toLowerCase()));
	fields.push(...rest(Object.keys(representation.binders).filter((k) => !listed.has(k.toLowerCase()))).map((k) => contextField(k, false)));
	return fields;
}

/** The text of the service's own error body, when it has one. */
function serviceMessage(data: unknown): string | undefined {
	let body = data;
	if (typeof data === 'string') {
		try {
			body = JSON.parse(data);
		} catch {
			return data.trim() || undefined;
		}
	}
	if (typeof body === 'string') return body.trim() || undefined;
	return isObject(body) && typeof body.message === 'string' && body.message ? body.message : undefined;
}

/** Reads `GET {deliveryUrl}/schema/msd/v1/{manifest}` with the node's credential. */
export async function readMsd(this: ILoadOptionsFunctions): Promise<unknown> {
	const creds = await this.getCredentials('enterspeedContextGraphApi');
	const deliveryUrl = String(creds.deliveryUrl ?? '').replace(/\/+$/, '');
	const manifest = String(creds.manifestVersion ?? '');
	const url = `${deliveryUrl}/schema/msd/${API_VERSION}/${encodeURIComponent(manifest)}`;
	let response: unknown;
	try {
		response = await contextGraphApiRequest.call(this, { method: 'GET', url, json: true });
	} catch (error) {
		const { status, data } = httpFailure(error);
		let message: string;
		if (status === undefined) message = `Couldn't reach the Delivery URL (${deliveryUrl}).`;
		else if (status === 401) message = 'The API key was rejected by the Delivery URL.';
		else message = serviceMessage(data) ?? (status === 404 ? `No schema for manifest "${manifest}".` : `The Delivery URL answered with status ${status}.`);
		throw new NodeOperationError(this.getNode(), message);
	}
	if (typeof response === 'string') {
		try {
			response = JSON.parse(response);
		} catch {
			throw new NodeOperationError(this.getNode(), "The Delivery URL didn't answer with a schema document.");
		}
	}
	return response;
}

const current = (ctx: ILoadOptionsFunctions, name: string): string => {
	const value = ctx.getCurrentNodeParameter(name);
	return typeof value === 'string' ? value : '';
};

const describeSlot = (s: MsdSlot) => (s.index ? `${s.name} (${s.type} on ${s.index})` : `${s.name} (${s.type})`);

// ── loadOptions ─────────────────────────────────────────────────────────────

export async function getRepresentations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const msd = await readMsd.call(this);
	const { max } = msdQueryLimits(msd);
	return msdRepresentations(msd).map((r) => ({
		name: r.name,
		value: r.name,
		description: `Slots: ${r.slots.map(describeSlot).join(', ') || 'none'}${max ? `. A query slot returns at most ${max} items.` : ''}`,
	}));
}

export async function getRepresentationRoutes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const name = current(this, 'representation');
	const representation = msdRepresentations(await readMsd.call(this)).find((r) => r.name === name);
	return (representation?.routes ?? []).map((route) => ({ name: route, value: route }));
}

export async function getIndexes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const msd = await readMsd.call(this);
	const { max } = msdQueryLimits(msd);
	return msdIndexes(msd).map((i) => ({
		name: i.name,
		value: i.name,
		description: [
			i.textFields.length ? `Search: ${i.textFields.join(', ')}` : 'No searchable fields',
			max ? `limit at most ${max}` : '',
		]
			.filter(Boolean)
			.join('. '),
	}));
}

const builderIndex = async (ctx: ILoadOptionsFunctions) => {
	const name = current(ctx, 'builderIndex');
	return msdIndexes(await readMsd.call(ctx)).find((i) => i.name === name);
};

/*
 * A filter or sort field's value carries its value class, `{class}:{field}`,
 * so the builder sends a number, boolean or string as the index declares
 * (delivery/ADR-037: filters are validated by value class).
 */
export type ValueClass = 'keyword' | 'numeric' | 'boolean';

export const classedField = (valueClass: ValueClass, field: string) => `${valueClass}:${field}`;

export function parseClassedField(value: string): { valueClass: ValueClass | undefined; field: string } {
	const at = value.indexOf(':');
	const valueClass = value.slice(0, at);
	return valueClass === 'keyword' || valueClass === 'numeric' || valueClass === 'boolean'
		? { valueClass, field: value.slice(at + 1) }
		: { valueClass: undefined, field: value };
}

const classedOptions = (index: MsdIndex | undefined): INodePropertyOptions[] => [
	...(index?.keywordFields ?? []).map((f) => ({ name: f, value: classedField('keyword', f), description: 'Text value' })),
	...(index?.numericFields ?? []).map((f) => ({ name: f, value: classedField('numeric', f), description: 'Number value' })),
	...(index?.booleanFields ?? []).map((f) => ({ name: f, value: classedField('boolean', f), description: 'True or false' })),
];

/** The fields a filter can match: the index's keyword, numeric and boolean fields. */
export async function getFilterFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return classedOptions(await builderIndex(this));
}

export const NO_SORTABLE_FIELDS = 'This index lists no sortable fields';

/**
 * The fields a sort can use: the index's `sortableFields`, in the schema's
 * order ("the fields a query may sort on", materialised-schema spec, Index;
 * delivery refuses a sort on any other field, sc-14365). A member is present
 * only when non-empty, so a missing `sortableFields` means none: the list says
 * so rather than offering fields delivery would refuse. Each field keeps the
 * value class its filter list gives it, so a saved value has the same
 * `{class}:{field}` form as before.
 */
export async function getSortFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const index = await builderIndex(this);
	if (!index) return [];
	if (!index.sortableFields.length) throw new NodeOperationError(this.getNode(), NO_SORTABLE_FIELDS);
	const classed = new Map(classedOptions(index).map((o) => [parseClassedField(String(o.value)).field, o]));
	return index.sortableFields.map((f) => classed.get(f) ?? { name: f, value: f });
}

/** The text fields a search can be narrowed to. */
export async function getSearchFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return ((await builderIndex(this))?.textFields ?? []).map((f) => ({ name: f, value: f }));
}

export async function getFilterOperators(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return msdFilterOperators(await readMsd.call(this)).map((o) => ({ name: o, value: o }));
}

export const NO_SHAPES = 'This schema lists no shapes';

export async function getSchemaShapes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const shapes = (await readMsd.call(this), msdShapes());
	if (!shapes.length) throw new NodeOperationError(this.getNode(), NO_SHAPES);
	return shapes.map((s) => ({ name: s.name, value: s.name, description: `ID segments: ${s.segments.join(', ')}` }));
}

// ── resourceMapping ─────────────────────────────────────────────────────────

export async function getRouteValues(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const name = current(this, 'representation');
	const route = current(this, 'representationRoute');
	const representation = msdRepresentations(await readMsd.call(this)).find((r) => r.name === name);
	if (!representation || !route) return { fields: [], emptyFieldsNotice: 'Choose a representation and a route first' };
	return { fields: representationFields(representation, route), emptyFieldsNotice: `${route} takes no values` };
}

export async function getShapeSegments(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const name = current(this, 'shapeName');
	const shape = (await readMsd.call(this), msdShapes()).find((s) => s.name === name);
	return {
		fields: (shape?.segments ?? []).map((key) => ({
			id: key,
			displayName: key,
			required: true,
			defaultMatch: false,
			display: true,
			type: 'string',
		})),
		emptyFieldsNotice: shape ? `${name} has no ID segments` : 'Choose a shape first',
	};
}
