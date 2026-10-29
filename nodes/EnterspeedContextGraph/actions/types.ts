/**
 * The Context Graph credential's URLs, normalised once per execution by
 * router.ts. The API key is deliberately absent: requests go through
 * `httpRequestWithAuthentication`, which adds it from the credential's
 * `authenticate` config, so operation code never handles it.
 */
export interface ContextGraphCredentials {
	ingestUrl: string;
	deliveryUrl: string;
	manifestVersion: string;
}
