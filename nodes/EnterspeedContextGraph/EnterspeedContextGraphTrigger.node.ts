import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IHookFunctions,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { properties } from './webhookTrigger/properties';
import { handleWebhook } from './webhookTrigger/handler';
import { checkWebhookCredential } from './webhookTrigger/signature';

/**
 * Enterspeed Context Graph Trigger: starts a workflow when the Context Graph
 * delivers an outbound envelope (a model commit changed some entries).
 *
 * Registration is manual: the node's production URL is registered as a
 * webhook subscription, whose signing secret goes in the node's own
 * credential. Properties and the handler live under ./webhookTrigger.
 */
export class EnterspeedContextGraphTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed Context Graph Trigger',
		name: 'enterspeedContextGraphTrigger',
		icon: { light: 'file:enterspeed.svg', dark: 'file:enterspeed.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["eventTypes"].length ? "Events: " + $parameter["eventTypes"].join(", ") : "All events"}}',
		description: 'Starts a workflow when Enterspeed Context Graph content changes',
		defaults: { name: 'Enterspeed Context Graph Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'enterspeedContextGraphWebhookApi',
				required: true,
				testedBy: 'enterspeedContextGraphWebhookTest',
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties,
	};

	methods = {
		credentialTest: {
			/** Nothing to call: checks the secret's form and the receiver header pair. */
			async enterspeedContextGraphWebhookTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const problem = checkWebhookCredential(credential.data ?? {});
				return problem
					? { status: 'Error', message: problem }
					: { status: 'OK', message: 'The signing secret is well-formed' };
			},
		},
	};

	/**
	 * Subscriptions are registered by hand in Enterspeed (registering on
	 * activation would need an operator token in n8n), so there is nothing to
	 * call: these report "already handled" rather than claim a registration.
	 */
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return handleWebhook.call(this);
	}
}
