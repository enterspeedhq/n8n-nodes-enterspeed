// The graph the end-to-end run serves: one snapshot source (`catalogue`) whose
// export holds products, a model, an index to read them back from and a
// representation with a route, and a push source (`enrichment`) the enrichment
// template writes to, with its own model and shape. It starts empty on every run.
import {
	defineEntity,
	defineSource,
	defineModel,
	defineEntryShape,
	defineIndexShape,
	defineRepresentation,
	defineModule,
	defineSchema,
	entryField,
	field,
	indexField,
	slot,
} from '@enterspeed/core';

const Product = defineEntity('product', {
	fields: {
		id: field.string(),
		name: field.string(),
	},
});

const Catalogue = defineSource('catalogue', { entities: [Product] });

// What the enrichment template writes: one record per product, in a source of
// its own. Its model is separate from ProductModel, so an enrichment changes
// only ProductEnrichment entries and never a ProductCard (the template's loop guard).
const ProductEnrichment = defineEntity('productEnrichment', {
	fields: {
		productId: field.string(),
		description: field.string(),
	},
});

const Enrichment = defineSource('enrichment', { entities: [ProductEnrichment] });

const productModel = defineModel('ProductModel', Product, {
	id: [{ field: 'id', key: 'productId' }],
	fields: {
		productId: field.string('id'),
		name: field.string('name'),
	},
});

const productCard = defineEntryShape('ProductCard', {
	of: productModel,
	fields: { productId: entryField.select(), name: entryField.select() },
});

const productEnrichmentModel = defineModel('ProductEnrichmentModel', ProductEnrichment, {
	id: [{ field: 'productId', key: 'productId' }],
	fields: {
		productId: field.string('productId'),
		description: field.string('description'),
	},
});

const productEnrichmentShape = defineEntryShape('ProductEnrichment', {
	of: productEnrichmentModel,
	fields: { productId: entryField.select(), description: entryField.select() },
});

const productIndex = defineIndexShape('ProductIndex', {
	of: productModel,
	description: 'Every product in the catalogue',
	fields: {
		productId: indexField.filterable('keyword', { sortable: true, description: 'Product id' }),
		name: indexField.filterable('keyword', { description: 'Product name' }),
	},
});

const productPage = defineRepresentation('ProductPage', {
	routes: ['/products/{productId}'],
	fields: ({ keys }) => ({
		product: slot.entry(productCard, { args: { productId: keys.productId } }),
	}),
});

export const schema = defineSchema({
	sources: [Catalogue, Enrichment],
	modules: [
		defineModule({ name: 'Catalogue', definitions: [productModel, productCard, productIndex] }),
		defineModule({ name: 'Enrichment', definitions: [productEnrichmentModel, productEnrichmentShape] }),
	],
	representations: [productPage],
});

// How the dev-server declares the sources: `catalogue` is a snapshot source, so
// it takes uploads (no cycle, so an upload deletes nothing); `enrichment` takes
// pushed records.
export const sources = { catalogue: { mode: 'snapshot' }, enrichment: { mode: 'push' } };
