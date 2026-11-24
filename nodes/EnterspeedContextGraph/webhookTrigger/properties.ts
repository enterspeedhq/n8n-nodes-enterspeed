import type { INodeProperties } from 'n8n-workflow';

export const properties: INodeProperties[] = [
	{
		displayName:
			"The webhook carries the event, never the data: one item per changed entry with its key, hash and action. Read the content with the Enterspeed Context Graph node. Register this node's production URL as the webhook subscription's URL.",
		name: 'eventNotice',
		type: 'notice',
		default: '',
	},
	{
		displayName: 'Event Types',
		name: 'eventTypes',
		type: 'multiOptions',
		options: [{ name: 'Model Changed', value: 'model-changed' }],
		default: [],
		description:
			'Which event types start the workflow. Leave empty to start on every type, including types added later. Other types are acknowledged and start nothing.',
	},
];
