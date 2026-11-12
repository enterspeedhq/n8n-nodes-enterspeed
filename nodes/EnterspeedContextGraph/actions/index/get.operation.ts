import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, NodeApiError } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { API_VERSION, deliveryError } from '../shape/shared';

const show = { resource: ['index'], operation: ['get'] };

export const properties: INodeProperties[] = [
	{
		displayName:
			"Reads one document from an index by its ID, one per input item, and outputs it unchanged. The SDK dev-server doesn't serve this read yet; it answers 404.",
		name: 'getNotice',
		type: 'notice',
		default: '',
		displayOptions: { show },
	},
	{
		displayName: 'Index Name or ID',
		name: 'indexName',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getIndexes' },
		default: '',
		required: true,
		description: 'The index to read from, from the schema of the manifest. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show },
	},
	{
		displayName: 'Document ID',
		name: 'documentId',
		type: 'string',
		default: '={{ $json.$id }}',
		required: true,
		placeholder: 'e.g. ProductIndex:productId:p-1001',
		description:
			'The document\'s ID in the index: its key, with the parts joined by colons. Each match a query returns carries it, which is what the default reads.',
		displayOptions: { show },
	},
];

/** Why a field can't be sent, or undefined if it can. Its value is never trimmed or converted. */
function invalidField(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return `has no ${name}`;
	if (typeof value !== 'string') return `has a ${name} that is not text`;
	return undefined;
}

function asObject(response: unknown): IDataObject | undefined {
	let value = response;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : undefined;
}

/** One item's document, or the error that stops it. */
async function readDocument(
	this: IExecuteFunctions,
	indexName: unknown,
	documentId: unknown,
	itemIndex: number,
	creds: ContextGraphCredentials,
): Promise<IDataObject | NodeApiError | NodeOperationError> {
	const problem = invalidField(indexName, 'Index Name') ?? invalidField(documentId, 'Document ID');
	if (problem) return new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });

	// Each is one path segment: the document ID is the colon-joined key, kept whole.
	const url = `${creds.deliveryUrl}/query/${API_VERSION}/${encodeURIComponent(creds.manifestVersion)}/${encodeURIComponent(indexName as string)}/${encodeURIComponent(documentId as string)}`;
	let response: unknown;
	try {
		response = await contextGraphApiRequest.call(this, { method: 'GET', url, json: true });
	} catch (error) {
		// Delivery answers a missing document, and one the key may not see, with the same bodiless 404.
		return deliveryError.call(this, error, creds, {
			itemIndex,
			notFound: `No document "${documentId}" in index "${indexName}".`,
		});
	}

	return (
		asObject(response) ??
		new NodeOperationError(
			this.getNode(),
			`The Delivery URL didn't answer with a document for "${documentId}" in index "${indexName}".`,
			{ itemIndex },
		)
	);
}

/**
 * Reads one document per input item from
 * `GET {deliveryUrl}/query/v1/{manifest}/{indexName}/{documentId}`, the
 * index point read (delivery/ADR-030 §3), and outputs it as it is: the
 * document's displayed fields (delivery/ADR-022). A missing document fails
 * the item.
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const indexName = this.getNodeParameter('indexName', itemIndex, undefined);
		const documentId = this.getNodeParameter('documentId', itemIndex, undefined);
		const document = await readDocument.call(this, indexName, documentId, itemIndex, creds);
		if (document instanceof Error) {
			if (!this.continueOnFail()) throw document;
			results.push({
				json: {
					indexName: indexName as IDataObject[string],
					documentId: documentId as IDataObject[string],
					error: document.message,
					...(document.description && { description: document.description }),
				},
				pairedItem: { item: itemIndex },
			});
		} else {
			results.push({ json: document, pairedItem: { item: itemIndex } });
		}
	}

	return results;
}
