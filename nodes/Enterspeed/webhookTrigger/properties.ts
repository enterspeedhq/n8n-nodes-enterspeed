import type { INodeProperties } from 'n8n-workflow';

export const properties: INodeProperties[] = [
	{
		displayName: 'Actions',
		name: 'actions',
		type: 'multiOptions',
		options: [
			{ name: 'Deploy (Published / Updated)', value: 'Deploy' },
			{ name: 'Remove (Deleted)', value: 'Remove' },
		],
		default: ['Deploy', 'Remove'],
		description: 'Which view actions should start the workflow',
	},
	{
		displayName: 'Fetch Full View',
		name: 'fetchView',
		type: 'boolean',
		default: true,
		description:
			'Whether to fetch the full view from the Delivery API (using the environment key) when the payload carries a delivery URL. Only deploys carry a URL.',
	},
	{
		displayName:
			'The Access Key is set on the webhook in Enterspeed, not here — paste that same value below. It is checked against the "X-Api-Key" header Enterspeed sends with each call, and is a different secret from the credential\'s API keys.',
		name: 'accessKeyNotice',
		type: 'notice',
		default: '',
	},
	{
		displayName: 'Access Key',
		name: 'accessKey',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		description:
			'Optional shared secret, set on the webhook in Enterspeed. If provided here, the incoming X-Api-Key header must match this value or the request is rejected with 403.',
	},
];
