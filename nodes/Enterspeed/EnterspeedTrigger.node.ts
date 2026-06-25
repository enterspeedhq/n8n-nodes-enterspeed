import type {
	IPollFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IDataObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/**
 * Enterspeed Trigger (polling).
 *
 * Enterspeed generates views at publish time and does not push outbound
 * webhooks to subscribers, so the robust trigger is to poll an index on a
 * schedule and emit items that are new or changed since the last run.
 *
 * State is kept per-workflow: a map of itemId -> change marker. On the first
 * run nothing is emitted (baseline), so you don't get a flood of existing items.
 *
 * If you later expose an outbound webhook from your own integration layer,
 * a separate webhook trigger can be added alongside this one.
 */
export class EnterspeedTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Enterspeed Trigger',
		name: 'enterspeedTrigger',
		icon: 'file:enterspeed.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{"Index: " + $parameter["indexAlias"]}}',
		description: 'Starts a workflow when items in an Enterspeed index change',
		defaults: { name: 'Enterspeed Trigger' },
		polling: true,
		inputs: [],
		outputs: ['main'],
		credentials: [{ name: 'enterspeedApi', required: true }],
		properties: [
			{
				displayName: 'Index Alias',
				name: 'indexAlias',
				type: 'string',
				required: true,
				default: '',
				description: 'Alias of the index to watch, e.g. productIndex',
			},
			{
				displayName: 'Change Marker Field',
				name: 'markerField',
				type: 'string',
				default: 'updatedAt',
				description:
					'Item field used to detect changes (e.g. updatedAt, version, hash). If empty, the whole item is hashed.',
			},
			{
				displayName: 'ID Field',
				name: 'idField',
				type: 'string',
				default: 'id',
				description: 'Item field that uniquely identifies an item',
			},
			{
				displayName: 'Query Body (JSON)',
				name: 'queryBody',
				type: 'json',
				default: '{\n  "pagination": { "page": 1, "size": 200 }\n}',
				description: 'Filters / sort / pagination passed to the Query API',
			},
			{
				displayName: 'Emit On First Poll',
				name: 'emitOnFirst',
				type: 'boolean',
				default: false,
				description: 'Whether to emit all current items on the first run instead of just setting a baseline',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const creds = await this.getCredentials('enterspeedApi');
		const envKey = creds.environmentApiKey as string;
		const queryHost = (creds.queryHost as string) ?? 'https://query.enterspeed.com';

		const indexAlias = this.getNodeParameter('indexAlias') as string;
		const markerField = this.getNodeParameter('markerField') as string;
		const idField = this.getNodeParameter('idField') as string;
		const emitOnFirst = this.getNodeParameter('emitOnFirst') as boolean;
		const queryBodyRaw = this.getNodeParameter('queryBody') as IDataObject | string;
		const queryBody = typeof queryBodyRaw === 'string' ? JSON.parse(queryBodyRaw) : queryBodyRaw;

		const response = (await this.helpers.httpRequest({
			method: 'POST',
			url: `${queryHost}/v1/${encodeURIComponent(indexAlias)}`,
			headers: { 'X-Api-Key': envKey },
			body: queryBody,
			json: true,
		})) as IDataObject;

		// Query API returns results under "results" (array of items).
		const results = (response.results ?? response.items ?? []) as IDataObject[];
		if (!Array.isArray(results)) {
			throw new NodeOperationError(this.getNode(), 'Unexpected Query API response shape', {
				description: 'Expected a "results" array.',
			});
		}

		const staticData = this.getWorkflowStaticData('node');
		const seen = (staticData.seen as Record<string, string>) ?? {};
		const isFirstRun = Object.keys(seen).length === 0 && staticData.initialised !== true;

		const marker = (item: IDataObject): string => {
			if (markerField && item[markerField] !== undefined) return String(item[markerField]);
			return JSON.stringify(item);
		};

		const changed: INodeExecutionData[] = [];
		const nextSeen: Record<string, string> = {};

		for (const item of results) {
			const id = String(item[idField] ?? item.id ?? '');
			if (!id) continue;
			const m = marker(item);
			nextSeen[id] = m;
			if (seen[id] === undefined || seen[id] !== m) {
				changed.push({ json: item });
			}
		}

		staticData.seen = nextSeen;
		staticData.initialised = true;

		if (isFirstRun && !emitOnFirst) return null;
		if (changed.length === 0) return null;
		return [changed];
	}
}
