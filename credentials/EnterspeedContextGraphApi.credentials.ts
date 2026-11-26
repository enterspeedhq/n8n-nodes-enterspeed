import type {
	ICredentialDataDecryptedObject,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
	ICredentialTestRequest,
} from 'n8n-workflow';

/**
 * Enterspeed Context Graph's two services each check their own key:
 *  - Ingest URL   + Ingest API Key   -> uploads
 *  - Delivery URL + Delivery API Key -> every read, and the credential test
 *
 * The URLs have no default: the Context Graph's hosts aren't Enterspeed
 * Core's, so a pre-filled Core host would send a Context Graph key to Core.
 * Every Delivery route is scoped to a manifest version, which is entered
 * here once rather than on each node.
 */
export class EnterspeedContextGraphApi implements ICredentialType {
	name = 'enterspeedContextGraphApi';

	displayName = 'Enterspeed Context Graph API';

	icon = { light: 'file:enterspeed.svg', dark: 'file:enterspeed.dark.svg' } as const;

	documentationUrl = 'https://docs.enterspeed.com';

	properties: INodeProperties[] = [
		{
			displayName: 'Ingest URL',
			name: 'ingestUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://ingest.example.com',
			description: 'Base URL of the Context Graph Ingest service, used for uploads. Not the Enterspeed Core host.',
		},
		{
			displayName: 'Ingest API Key',
			name: 'ingestApiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'The key the Ingest service accepts. Sent as the X-Api-Key header only on requests to the Ingest URL.',
		},
		{
			displayName: 'Delivery URL',
			name: 'deliveryUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://delivery.example.com',
			description: 'Base URL of the Context Graph Delivery service, used for reads. Not the Enterspeed Core host.',
		},
		{
			displayName: 'Delivery API Key',
			name: 'deliveryApiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'The key the Delivery service accepts. Sent as the X-Api-Key header only on requests to the Delivery URL.',
		},
		{
			displayName: 'Manifest Version',
			name: 'manifestVersion',
			type: 'string',
			required: true,
			default: '1.0.0',
			description: 'The manifest version every Delivery route is scoped to (the {manifest} segment)',
		},
	];

	/**
	 * Adds the X-Api-Key header: the Ingest API Key on a request under the
	 * Ingest URL, the Delivery API Key on a request under the Delivery URL,
	 * and no key on a request to anywhere else. "Under" means the same origin
	 * (scheme, host and port) and a path at or below the configured path.
	 */
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const target = parseUrl(joinUrl(requestOptions.baseURL, requestOptions.url));
		const services = [
			{ base: parseUrl(credentials.ingestUrl), key: credentials.ingestApiKey },
			{ base: parseUrl(credentials.deliveryUrl), key: credentials.deliveryApiKey },
		];
		// If one URL sits under the other, the more specific one wins. If both are
		// the same URL (the dev-server serves both services from one host), the
		// Ingest API Key goes there: the host is the configured one either way.
		const match = services
			.filter((s) => target && s.base && isUnder(target, s.base))
			.sort((a, b) => path(b.base!).length - path(a.base!).length)[0];
		if (!match) return requestOptions;
		return {
			...requestOptions,
			headers: { ...requestOptions.headers, 'X-Api-Key': String(match.key ?? '') },
		};
	}

	/**
	 * Reads the manifest document — a read-only route that the deployed
	 * Delivery service guards with the key (401 on a missing or unknown
	 * key) and that 404s when the manifest version isn't hosted. Note the
	 * dev-server accepts any key, so only reachability and the manifest
	 * version are checked against it. The Ingest API Key isn't tested.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.deliveryUrl.replace(/\\/+$/, "")}}',
			url: '=/schema/msd/v1/{{$credentials.manifestVersion}}',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'The Delivery API Key was rejected. Check it.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message: 'No manifest with this version at the Delivery URL. Check the Manifest Version and Delivery URL.',
				},
			},
		],
	};
}

/** How the HTTP client builds the request URL: an absolute `url` stands alone, a relative one goes after `baseURL`. */
function joinUrl(baseURL: string | undefined, url: string): string {
	if (!baseURL || /^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
	return `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

function parseUrl(value: unknown): URL | undefined {
	if (typeof value !== 'string' || value.trim() === '') return undefined;
	try {
		return new URL(value.trim());
	} catch {
		return undefined;
	}
}

/** The URL's path without trailing slashes, so `https://x/` and `https://x` match alike. */
const path = (url: URL) => url.pathname.replace(/\/+$/, '');

function isUnder(target: URL, base: URL): boolean {
	if (target.origin !== base.origin) return false;
	const prefix = path(base);
	const targetPath = path(target);
	return targetPath === prefix || targetPath.startsWith(`${prefix}/`);
}
