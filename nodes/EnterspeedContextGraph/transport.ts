import type {
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

/**
 * Thin wrapper shared by every operation. Authenticates with the
 * `enterspeedContextGraphApi` credential, which adds the X-Api-Key header.
 *
 * Every request is sent with `ignoreHttpStatusErrors` and read in full: when
 * n8n's request helper fails a request itself, the NodeApiError it throws
 * keeps only the status code, not the body or the headers (seen in n8n
 * 2.27), and the operations need both: a problem's `detail`, a 503's
 * Retry-After, a 304's ETag. A status outside 2xx is thrown here instead, as
 * a NodeApiError whose `cause` holds the response, so httpFailure reads it.
 * The caller gets the body, or the full response if it asked for one.
 */
export async function contextGraphApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	options: IHttpRequestOptions,
): Promise<unknown> {
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'enterspeedContextGraphApi', {
		...options,
		ignoreHttpStatusErrors: true,
		returnFullResponse: true,
	})) as IN8nHttpFullResponse;
	if (response.statusCode >= 200 && response.statusCode < 300) {
		return options.returnFullResponse ? response : response.body;
	}
	const httpCode = String(response.statusCode);
	const error = new NodeApiError(this.getNode(), { message: `Request failed with status code ${httpCode}`, httpCode }, { httpCode });
	throw Object.assign(error, {
		cause: { httpCode, response: { status: response.statusCode, data: response.body, headers: response.headers } },
	});
}

interface HttpError {
	httpCode?: string | null;
	statusCode?: number;
	response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
	cause?: HttpError;
}

/**
 * The status, body and headers of a failed request: the NodeApiError
 * contextGraphApiRequest throws holds them in its `cause`; a plain HTTP error
 * holds them itself, so both are looked at. No status means there was no
 * answer at all.
 */
export function httpFailure(error: unknown): {
	status?: number;
	data?: unknown;
	headers?: Record<string, unknown>;
} {
	const e = (error ?? {}) as HttpError;
	const response = e.response ?? e.cause?.response;
	const code = e.httpCode ?? e.cause?.httpCode;
	const status = response?.status ?? e.statusCode ?? (code ? Number(code) : undefined);
	return {
		status: status === undefined || Number.isNaN(status) ? undefined : status,
		data: response?.data,
		headers: response?.headers,
	};
}

/**
 * delivery/ADR-025 Decision 3: a read Delivery can't serve right now (load
 * shed, a store or search outage, a timed-out resolution) is answered `503`
 * with `Retry-After` and `X-Delivery-Retry-After-Ms`; "503's purpose is to
 * drive retry" (Decision 5). Like Delivery's own clients, the node retries once, and not at
 * all when the wait asked for is longer than this.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** The retry waits up to this much longer than asked, so retries spread out (as Delivery's clients do). */
export const MAX_RETRY_JITTER_MS = 1_000;

/** What failed reads say when Delivery answers `503`, retried or not. */
export const DELIVERY_BUSY_MESSAGE = "The Delivery URL is busy or can't answer right now (status 503). Try again later.";

/** A response header's value, looked up by its lower-case name; the first value if it came more than once. */
export function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
	const value = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
	return value === undefined || value === null ? undefined : String(value);
}

/**
 * The wait a `503` asks for, in milliseconds: `X-Delivery-Retry-After-Ms`,
 * else `Retry-After` in whole seconds. A value that is negative, not a number,
 * an HTTP date or over MAX_RETRY_AFTER_MS doesn't count, and with none left the
 * answer is undefined: no retry. The same rules as Delivery's own clients.
 */
export function deliveryRetryAfterMs(headers: Record<string, unknown> | undefined): number | undefined {
	const preciseRaw = header(headers, 'x-delivery-retry-after-ms');
	if (preciseRaw !== undefined && preciseRaw.trim() !== '') {
		const ms = Number(preciseRaw);
		if (Number.isFinite(ms) && ms >= 0 && ms <= MAX_RETRY_AFTER_MS) return ms;
	}
	const secondsRaw = header(headers, 'retry-after');
	if (secondsRaw !== undefined && secondsRaw.trim() !== '') {
		const seconds = Number(secondsRaw);
		if (Number.isInteger(seconds) && seconds >= 0 && seconds * 1000 <= MAX_RETRY_AFTER_MS) return seconds * 1000;
	}
	return undefined;
}

/** The wait asked for plus a random jitter in `[0, min(wait / 2, MAX_RETRY_JITTER_MS))`. */
export function retryDelayMs(retryAfterMs: number, random: () => number = Math.random): number {
	return retryAfterMs + Math.floor(random() * Math.min(retryAfterMs / 2, MAX_RETRY_JITTER_MS));
}

/**
 * Sends one Delivery read. A `503` with a usable wait is sent once more, the
 * same request, after that wait plus jitter (delivery/ADR-025 Decision 3).
 * Any other failure, a `503` without a usable wait, or a second failure is
 * thrown for the operation to word.
 */
export async function deliveryReadRequest(this: IExecuteFunctions, options: IHttpRequestOptions): Promise<unknown> {
	try {
		return await contextGraphApiRequest.call(this, options);
	} catch (error) {
		const { status, headers } = httpFailure(error);
		const waitMs = status === 503 ? deliveryRetryAfterMs(headers) : undefined;
		// n8n hands the failure over as a NodeApiError already, which this
		// passes on unchanged; httpFailure reads either form.
		if (waitMs === undefined) throw new NodeApiError(this.getNode(), error as JsonObject);
		await sleep(retryDelayMs(waitMs));
		return await contextGraphApiRequest.call(this, options);
	}
}
