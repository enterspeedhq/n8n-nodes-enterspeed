import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * What the Enterspeed Context Graph Trigger checks an incoming delivery with.
 * Each webhook subscription has its own signing secret, so this is its own
 * credential, never the Context Graph API one: one credential per
 * subscription. Nothing here is sent anywhere; the trigger only compares,
 * so there is no request to test it with. The trigger's `testedBy` method
 * checks that the secret is a signing secret instead.
 */
export class EnterspeedContextGraphWebhookApi implements ICredentialType {
	name = 'enterspeedContextGraphWebhookApi';

	displayName = 'Enterspeed Context Graph Webhook API';

	icon = { light: 'file:enterspeed.svg', dark: 'file:enterspeed.dark.svg' } as const;

	documentationUrl = 'https://docs.enterspeed.com';

	properties: INodeProperties[] = [
		{
			displayName: 'Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'whsec_...',
			description:
				"The webhook subscription's signing secret, whsec_ followed by base64, exactly as it was issued (or as the dev-server printed it). Every delivery's webhook-signature header is checked with it.",
		},
		{
			displayName: 'Receiver Header Name',
			name: 'receiverHeaderName',
			type: 'string',
			default: '',
			placeholder: 'X-Api-Key',
			description:
				"Optional. The header name of the subscription's receiver credential. When set, a delivery without this header and value is rejected.",
		},
		{
			displayName: 'Receiver Header Value',
			name: 'receiverHeaderSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: "The receiver credential's value, exactly as set on the subscription",
		},
	];
}
