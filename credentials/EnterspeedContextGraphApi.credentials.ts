import type {
	IAuthenticateGeneric,
	ICredentialType,
	INodeProperties,
	ICredentialTestRequest,
} from 'n8n-workflow';

/**
 * Enterspeed Context Graph uses one API key for both of its services:
 *  - Ingest URL   -> uploads
 *  - Delivery URL -> reads (shapes, query, schema)
 *
 * In the deployed platform these are separate hosts; the local dev-server
 * serves both from one address, so both URLs point at it. Every Delivery
 * route is scoped to a manifest version, which is entered here once rather
 * than on each node.
 */
export class EnterspeedContextGraphApi implements ICredentialType {
	name = 'enterspeedContextGraphApi';

	displayName = 'Enterspeed Context Graph API';

	icon = { light: 'file:enterspeed.svg', dark: 'file:enterspeed.dark.svg' } as const;

	documentationUrl = 'https://docs.enterspeed.com';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'Key for the Context Graph environment. Sent as the X-Api-Key header.',
		},
		{
			displayName: 'Ingest URL',
			name: 'ingestUrl',
			type: 'string',
			required: true,
			default: 'https://api.enterspeed.com',
			description: 'Base URL of the Ingest service, used for uploads. Against the dev-server, use the same address as the Delivery URL.',
		},
		{
			displayName: 'Delivery URL',
			name: 'deliveryUrl',
			type: 'string',
			required: true,
			default: 'https://delivery.enterspeed.com',
			description: 'Base URL of the Delivery service, used for reads',
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

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-Api-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * Reads the manifest document — a read-only route that the deployed
	 * Delivery service guards with the API key (401 on a missing or unknown
	 * key) and that 404s when the manifest version isn't hosted. Note the
	 * dev-server accepts any key, so only reachability and the manifest
	 * version are checked against it.
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
					message: 'The API key was rejected. Check the API Key.',
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
