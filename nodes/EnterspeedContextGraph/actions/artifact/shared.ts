import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { httpFailure } from '../../transport';
import type { ContextGraphCredentials } from '../types';
import { INGEST_API_VERSION } from '../entity/shared';

/** `{ingestUrl}/v1/sources/{alias}/artifacts`, the artifact drop (*Ingest artifact* spec). */
export const artifactsUrl = (creds: ContextGraphCredentials, source: string) =>
	`${creds.ingestUrl}/${INGEST_API_VERSION}/sources/${encodeURIComponent(source)}/artifacts`;

/** Every artifact refusal's problem `type` starts with this (*Ingest artifact* spec, Refusals). */
const PROBLEM_TYPE_PREFIX = 'urn:enterspeed:problem:artifact:';

export function asObject(value: unknown): IDataObject | undefined {
	if (typeof value === 'string') {
		try {
			return asObject(JSON.parse(value));
		} catch {
			return undefined;
		}
	}
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : undefined;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * The parts of a refusal's problem details (`application/problem+json`) a
 * sender can act on: the reason from its `type` (e.g. `push-source`), and the
 * platform's `title` and `detail`.
 */
export function problemDetails(data: unknown): { reason?: string; title?: string; detail?: string } {
	const body = asObject(data);
	if (!body) return {};
	const type = text(body.type);
	return {
		reason: type?.startsWith(PROBLEM_TYPE_PREFIX) ? type.slice(PROBLEM_TYPE_PREFIX.length) : undefined,
		title: text(body.title),
		detail: text(body.detail),
	};
}

/**
 * Turns a failed artifact request into a node error. A refusal is named by its
 * problem type and the platform's own title, with its detail as the
 * description. The API key and the file's content are never included.
 */
export function ingestError(
	this: IExecuteFunctions,
	error: unknown,
	creds: ContextGraphCredentials,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	const { status, data } = httpFailure(error);
	// No status means no answer at all.
	if (status === undefined) {
		return new NodeOperationError(this.getNode(), `Couldn't reach the Ingest URL (${creds.ingestUrl}).`, {
			description: (error as Error).message,
			itemIndex,
		});
	}
	const { reason, title, detail } = problemDetails(data);
	let message: string;
	if (title && reason) message = `${title} (${reason})`;
	else if (title) message = title;
	else if (status === 401) message = 'The API key was rejected by the Ingest URL.';
	// A 403 without a problem body is a key without Write scope (ingest ADR 011).
	else if (status === 403) message = "The API key isn't allowed to write to this Context Graph.";
	else message = `The Ingest URL answered with status ${status}.`;

	const httpCode = String(status);
	// A plain object, not the request's own error: NodeApiError hands back an
	// existing NodeApiError unchanged, which would drop this message.
	return new NodeApiError(this.getNode(), { httpCode }, { message, description: detail, httpCode, itemIndex });
}
