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
			description: 'The key the Ingest service accepts. Sent as the X-Api-Key header on uploads only.',
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
			description: 'The key the Delivery service accepts. Sent as the X-Api-Key header on reads only.',
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
	 * Adds the X-Api-Key header: the Ingest API Key on a request to the
	 * Ingest URL (or under it), the Delivery API Key on every other.
	 */
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const base = (url: unknown) => String(url ?? '').replace(/\/+$/, '');
		const target = `${requestOptions.baseURL ?? ''}${requestOptions.url}`;
		const ingest = base(credentials.ingestUrl);
		const toIngest = ingest !== '' && (target === ingest || target.startsWith(`${ingest}/`));
		return {
			...requestOptions,
			headers: {
				...requestOptions.headers,
				'X-Api-Key': String((toIngest ? credentials.ingestApiKey : credentials.deliveryApiKey) ?? ''),
			},
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
