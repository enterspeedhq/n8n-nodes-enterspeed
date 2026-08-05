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
		displayName: 'Access Key',
		name: 'accessKey',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		description:
			'Optional shared secret. If set, the incoming X-Api-Key header must match this value or the request is rejected with 403. Set the same value when configuring the webhook in Enterspeed.',
	},
];
