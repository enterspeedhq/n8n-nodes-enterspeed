import { createHash } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
	INodeProperties,
	NodeApiError,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { contextGraphApiRequest, httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { artifactsUrl, asObject, ingestError } from './shared';

const show = { resource: ['artifact'], operation: ['upload'] };

/** The two formats an artifact may take (ingest/ADR-019 D1), by the value saved in the workflow. */
const CONTENT_TYPES: Record<string, string> = {
	csv: 'text/csv',
	ndjson: 'application/x-ndjson',
};

export const properties: INodeProperties[] = [
	{
		displayName:
			"Uploads a source's complete export, as it is, one file per input item. The source must be a snapshot source. Use Entity › Push for records as they change. Size limit: n8n holds the file in memory while it is sent, so it must be under 2 GB (the Context Graph's limit too). In queue mode n8n keeps files in its database, which caps them at 512 MiB unless N8N_BINARY_DATA_DATABASE_MAX_FILE_SIZE is raised (at most 1 GiB).",
		name: 'uploadNotice',
		type: 'notice',
		default: '',
		displayOptions: { show },
	},
	{
		displayName: 'Source',
		name: 'sourceAlias',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. pim',
		description: 'The alias of the snapshot source the export belongs to',
		displayOptions: { show },
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		description: "The input item's binary field that holds the export file. The file is sent as it is.",
		displayOptions: { show },
	},
	{
		displayName: 'Content Type',
		name: 'contentType',
		type: 'options',
		options: [
			{ name: 'CSV', value: 'csv', description: "Read through the source's field map" },
			{ name: 'NDJSON', value: 'ndjson', description: "One record per line, keyed by the line's own key fields unless the source has a field map" },
		],
		default: 'ndjson',
		description: "The export's format. Set it here: it is not taken from the file's MIME type.",
		displayOptions: { show },
	},
	{
		displayName: 'As Of',
		name: 'asOf',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 2026-11-19T02:00:00Z',
		description:
			'When the export started in the source, as an ISO 8601 time with an offset. Not when the file was fetched or uploaded: every row is ordered at this time. Each upload must be later than the last one committed.',
		displayOptions: { show },
	},
	{
		displayName: 'Row Count',
		name: 'rowCount',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 1250000',
		description:
			'How many records the source exported: CSV rows after the header, or NDJSON lines that are not blank. Take it from the source, not from counting the file: a count that differs from the file means records are missing, and the upload then deletes nothing.',
		displayOptions: { show },
	},
];

const UPLOAD_METHODS: IHttpRequestMethods[] = ['PUT', 'POST', 'PATCH'];

/** The reservation's `upload.method` as a method n8n can send, or undefined. */
const uploadMethod = (value: unknown): IHttpRequestMethods | undefined =>
	typeof value === 'string' ? UPLOAD_METHODS.find((m) => m === value.toUpperCase()) : undefined;

/** A whole number of 0 or more, given as a number or as text, or undefined. */
function wholeNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
		const n = Number(value.trim());
		return Number.isSafeInteger(n) ? n : undefined;
	}
	return undefined;
}

const blank = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && !value.trim());

/** One item's export, ready to reserve, or why it can't be sent. */
interface Export {
	source: string;
	asOf: string;
	rowCount: number;
	contentType: string;
	bytes: Buffer;
}

async function readExport(this: IExecuteFunctions, itemIndex: number): Promise<Export | NodeOperationError> {
	const fail = (problem: string) =>
		new NodeOperationError(this.getNode(), `Item ${itemIndex} ${problem}.`, { itemIndex });

	const source = this.getNodeParameter('sourceAlias', itemIndex, undefined);
	const asOf = this.getNodeParameter('asOf', itemIndex, undefined);
	const rowCountValue = this.getNodeParameter('rowCount', itemIndex, undefined);
	const contentType = CONTENT_TYPES[this.getNodeParameter('contentType', itemIndex, 'ndjson') as string];
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;

	if (blank(source)) return fail('has no Source');
	if (typeof source !== 'string') return fail('has a Source that is not text');
	if (blank(asOf)) return fail('has no As Of');
	if (typeof asOf !== 'string') return fail('has an As Of that is not text');
	if (blank(rowCountValue)) return fail('has no Row Count');
	const rowCount = wholeNumber(rowCountValue);
	if (rowCount === undefined) return fail('has a Row Count that is not a whole number of 0 or more');
	if (!contentType) return fail('has no Content Type');
	if (!this.getInputData()[itemIndex]?.binary?.[binaryPropertyName]) {
		return fail(`has no binary data in "${binaryPropertyName}"`);
	}

	let bytes: Buffer;
	try {
		bytes = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	} catch (error) {
		// Node reads at most 2 GiB - 1 byte into memory (measured in n8n 2.27.4).
		if ((error as { code?: unknown }).code === 'ERR_FS_FILE_TOO_LARGE') {
			return fail(`has a file too large for n8n to hold in memory (2 GiB or more); the limit is 2 GB`);
		}
		return new NodeOperationError(this.getNode(), error as Error, { itemIndex });
	}
	return { source, asOf, rowCount, contentType, bytes };
}

/**
 * Sends the bytes to the signed URL with exactly the method and headers the
 * reservation named, through plain `httpRequest`: the credential's key must
 * never reach storage. The URL itself carries the signature, so only its
 * origin is ever put in an error.
 */
async function uploadBytes(
	this: IExecuteFunctions,
	upload: IDataObject,
	bytes: Buffer,
	itemIndex: number,
): Promise<NodeOperationError | undefined> {
	const url = upload.url;
	const method = uploadMethod(upload.method ?? 'PUT');
	if (typeof url !== 'string' || !method) {
		return new NodeOperationError(this.getNode(), "The Ingest URL's reservation named no upload this node can send.", {
			itemIndex,
		});
	}
	let origin = 'the signed upload URL';
	try {
		origin = new URL(url).origin;
	} catch {
		// Not a URL: the request below fails and says so without it.
	}
	try {
		await this.helpers.httpRequest({
			method,
			url,
			headers: asObject(upload.headers) ?? {},
			body: bytes,
			json: false,
		});
		return undefined;
	} catch (error) {
		const { status } = httpFailure(error);
		const message =
			status === undefined
				? `Couldn't reach the upload URL at ${origin}.`
				: `The upload to ${origin} failed with status ${status}.`;
		return new NodeOperationError(this.getNode(), message, { itemIndex });
	}
}

/**
 * Reserves, uploads and commits one export (ingest/ADR-017 D1): returns the
 * artifact as the Ingest URL answered the commit, or the error that stops
 * the item.
 */
async function uploadExport(
	this: IExecuteFunctions,
	itemIndex: number,
	creds: ContextGraphCredentials,
): Promise<{ artifact: IDataObject } | { error: NodeApiError | NodeOperationError }> {
	const read = await readExport.call(this, itemIndex);
	if (read instanceof NodeOperationError) return { error: read };
	const { source, asOf, rowCount, contentType, bytes } = read;
	const url = artifactsUrl(creds, source);

	let reserved: IDataObject | undefined;
	try {
		reserved = asObject(
			await contextGraphApiRequest.call(this, {
				method: 'POST',
				url,
				body: {
					asOf,
					rowCount,
					contentType,
					// ingest/ADR-017 D2: the SHA-256 of exactly the bytes uploaded.
					contentHash: createHash('sha256').update(bytes).digest('hex'),
				},
				json: true,
			}),
		);
	} catch (error) {
		return { error: ingestError.call(this, error, creds, itemIndex) };
	}
	const id = reserved?.id;
	if (!reserved || typeof id !== 'string' || !id) {
		return {
			error: new NodeOperationError(this.getNode(), "The Ingest URL didn't answer the reservation with an artifact.", {
				itemIndex,
			}),
		};
	}

	// A retry of an artifact already committed answers with it and no upload
	// (ingest/ADR-017 D3): there is nothing left to send.
	const upload = asObject(reserved.upload);
	if (!upload) return { artifact: reserved };

	const uploadError = await uploadBytes.call(this, upload, bytes, itemIndex);
	if (uploadError) return { error: uploadError };

	try {
		const committed = asObject(
			await contextGraphApiRequest.call(this, {
				method: 'POST',
				url: `${url}/${encodeURIComponent(id)}/commit`,
				json: true,
			}),
		);
		return { artifact: committed ?? reserved };
	} catch (error) {
		return { error: ingestError.call(this, error, creds, itemIndex) };
	}
}

/**
 * Uploads one export file per input item to a snapshot source through the
 * artifact drop (*Ingest artifact* spec): reserve with the four declared facts,
 * upload the bytes to the signed URL, commit. Outputs the artifact as the
 * Ingest URL answered, unchanged, paired to its item. The file is only hashed,
 * never parsed, mapped or counted: Row Count and As Of are the source's
 * (ingest/ADR-017 D2).
 */
export async function execute(
	this: IExecuteFunctions,
	creds: ContextGraphCredentials,
): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const results: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const outcome = await uploadExport.call(this, itemIndex, creds);
		if ('error' in outcome) {
			const { error } = outcome;
			if (!this.continueOnFail()) throw error;
			results.push({
				json: {
					source: this.getNodeParameter('sourceAlias', itemIndex, undefined) as IDataObject[string],
					asOf: this.getNodeParameter('asOf', itemIndex, undefined) as IDataObject[string],
					error: error.message,
					...(error.description && { description: error.description }),
				},
				pairedItem: { item: itemIndex },
			});
		} else {
			results.push({ json: outcome.artifact, pairedItem: { item: itemIndex } });
		}
	}

	return results;
}
