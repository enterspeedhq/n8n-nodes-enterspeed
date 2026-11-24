import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Standard Webhooks verification of an outbound envelope delivery, as the
 * semantic-graph spec `contracts/spec/outbound-envelope.md` (§ Signature
 * headers) defines it:
 *
 * - `webhook-signature` is `v1,` and the padded base64 of HMAC-SHA256 over
 *   `{webhook-id}.{webhook-timestamp}.` followed by the exact body bytes.
 * - The HMAC key is the secret's base64 after the `whsec_` prefix, decoded.
 * - During a rotation's overlap the header holds two signatures separated by
 *   a space; the request verifies when any one of them does.
 * - `webhook-timestamp` is Unix seconds; a request outside the tolerance is
 *   refused (five minutes, the Standard Webhooks libraries' default).
 */

export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const SECRET_PREFIX = 'whsec_';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type SignatureFailure =
	| 'missing-headers'
	| 'invalid-timestamp'
	| 'timestamp-out-of-tolerance'
	| 'invalid-secret'
	| 'no-matching-signature';

export interface SignatureHeaders {
	id: string | undefined;
	timestamp: string | undefined;
	signature: string | undefined;
}

/** The HMAC key a signing secret names, or undefined when it isn't one. */
export function signingKey(secret: string): Buffer | undefined {
	const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
	if (!BASE64.test(encoded)) return undefined;
	const key = Buffer.from(encoded, 'base64');
	return key.length > 0 ? key : undefined;
}

/** `v1,` and the base64 of the signature over the id, timestamp and body. */
export function sign(key: Buffer, id: string, timestamp: string, body: Buffer): string {
	const mac = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
	return `v1,${mac}`;
}

/**
 * Checks a delivery's three headers against its raw body. Returns undefined
 * when it verifies, else which check failed (never the secret or a signature).
 */
export function verifySignature(
	secret: string,
	headers: SignatureHeaders,
	body: Buffer,
	nowSeconds: number,
): SignatureFailure | undefined {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature) return 'missing-headers';
	if (!/^\d{1,15}$/.test(timestamp)) return 'invalid-timestamp';
	if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
		return 'timestamp-out-of-tolerance';
	}
	const key = signingKey(secret);
	if (!key) return 'invalid-secret';

	const expected = Buffer.from(sign(key, id, timestamp, body).slice('v1,'.length), 'base64');
	const matches = signature
		.split(' ')
		.filter((entry) => entry.startsWith('v1,'))
		.some((entry) => {
			const candidate = Buffer.from(entry.slice('v1,'.length), 'base64');
			return candidate.length === expected.length && timingSafeEqual(candidate, expected);
		});
	return matches ? undefined : 'no-matching-signature';
}

/** Compares two header values in constant time for equal lengths. */
export function headerValueMatches(received: string, expected: string): boolean {
	const a = Buffer.from(received);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What is wrong with a webhook credential, or undefined when nothing is: the
 * signing secret must decode to a key, and a receiver header name needs a value.
 */
export function checkWebhookCredential(data: Record<string, unknown>): string | undefined {
	if (!signingKey(String(data.signingSecret ?? ''))) {
		return 'The signing secret must be whsec_ followed by base64, exactly as it was issued';
	}
	const name = String(data.receiverHeaderName ?? '').trim();
	if (name !== '' && String(data.receiverHeaderSecret ?? '') === '') {
		return 'A receiver header name needs its value';
	}
	return undefined;
}
