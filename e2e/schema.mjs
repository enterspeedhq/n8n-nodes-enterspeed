// The graph the end-to-end run serves: one snapshot source (`catalogue`) whose
// export holds products, a model, an index to read them back from and a
// representation with a route. It starts empty on every run.
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
	sources: [Catalogue],
	modules: [
		defineModule({ name: 'Catalogue', definitions: [productModel, productCard, productIndex] }),
	],
	representations: [productPage],
});

// How the dev-server declares the source: a snapshot source, so it takes
// uploads. No cycle, so an upload deletes nothing.
export const sources = { catalogue: { mode: 'snapshot' } };
