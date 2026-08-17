import type { IDataObject } from 'n8n-workflow';

export const MAX_BULK_ENTITIES = 50;

/**
 * n8n's convention is for delete operations to return `{ "deleted": true }`,
 * but the Ingest API's delete response may carry useful info of its own (and
 * has no fixed schema — see ARCHITECTURE.md). Merge rather than replace: keep
 * whatever the API returned, and guarantee `deleted: true` on top of it.
 */
export function withDeletedFlag(response: unknown): IDataObject {
	if (response && typeof response === 'object' && !Array.isArray(response)) {
		return { ...(response as IDataObject), deleted: true };
	}
	if (response === undefined || response === null || response === '') {
		return { deleted: true };
	}
	return { deleted: true, response };
}
