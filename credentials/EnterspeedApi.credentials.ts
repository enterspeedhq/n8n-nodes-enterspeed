import type {
	ICredentialType,
	INodeProperties,
	ICredentialTestRequest,
} from 'n8n-workflow';

/**
 * Enterspeed uses two different API keys:
 *  - Source key      -> Ingest API   (api.enterspeed.com)
 *  - Environment key -> Delivery / Query / Routes APIs
 *
 * Both are entered by the customer at runtime. Nothing is hard-coded.
 * Host fields are pre-filled with the public endpoints and only need
 * changing for dedicated / region-specific tenants.
 */
export class EnterspeedApi implements ICredentialType {
	name = 'enterspeedApi';

	displayName = 'Enterspeed API';

	documentationUrl = 'https://docs.enterspeed.com/api';

	properties: INodeProperties[] = [
		{
			displayName: 'Environment API Key',
			name: 'environmentApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Key from an Environment client (Settings → Environment settings). Used for Delivery, Query and Routes.',
			placeholder: 'environment-1637c4d0-e878-4738-b866-152106a4f88c',
		},
		{
			displayName: 'Source API Key',
			name: 'sourceApiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Key from a Data source (Settings → Data sources). Used for the Ingest API.',
			placeholder: 'source-90880177-e9a1-47b3-9a40-7b728a6bafd8',
		},
		{
			displayName: 'Ingest API Host',
			name: 'ingestHost',
			type: 'string',
			default: 'https://api.enterspeed.com',
			description: 'Base host for the Ingest and Routes APIs',
		},
		{
			displayName: 'Delivery API Host',
			name: 'deliveryHost',
			type: 'string',
			default: 'https://delivery.enterspeed.com',
		},
		{
			displayName: 'Query API Host',
			name: 'queryHost',
			type: 'string',
			default: 'https://query.enterspeed.com',
		},
	];

	/**
	 * Verifies the environment key by calling the Routes API.
	 * `first=100` is the minimum allowed value.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.ingestHost}}',
			url: '/routes/v1',
			qs: { first: 100 },
			headers: {
				'X-Api-Key': '={{$credentials.environmentApiKey}}',
			},
		},
	};
}
