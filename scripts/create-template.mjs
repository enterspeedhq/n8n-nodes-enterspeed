#!/usr/bin/env node
// Exports a workflow from a running n8n container (or a raw JSON file
// downloaded via the n8n UI) and writes a sanitized copy into
// workflows/templates/, ready to pass tests/workflow-templates.test.ts.
//
// Sanitizing means: only a fixed allow-list of fields is carried over (name,
// active, nodes, connections, settings), `active` is forced to false, `meta`/
// `pinData` are reset to the template convention, and every node credential's
// `id` is replaced with the `__ENTERSPEED_CREDENTIAL_ID__` placeholder. This
// drops workflow id/versionId/shared/staticData/tags/etc. by construction —
// tests/workflow-templates.test.ts scans the whole file for any leftover
// 16-character credential/instance ID, so an allow-list is safer than trying
// to enumerate every field to strip.
//
// Usage:
//   node scripts/create-template.mjs --name "Poll Index for Changes"
//   node scripts/create-template.mjs --id <workflowId> --out my-template.json
//   node scripts/create-template.mjs --file ./downloaded-workflow.json --out my-template.json
//
// Optional env vars:
//   N8N_CONTAINER  (default: n8n-nodes-enterspeed-n8n-1)

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES_DIR = join(ROOT, 'workflows', 'templates');
const CONTAINER = process.env.N8N_CONTAINER ?? 'n8n-nodes-enterspeed-n8n-1';
const PLACEHOLDER = '__ENTERSPEED_CREDENTIAL_ID__';

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, '');
		if (!key) continue;
		args[key] = argv[i + 1];
	}
	return args;
}

function toKebabCase(name) {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function loadFromFile(path) {
	const parsed = JSON.parse(readFileSync(path, 'utf-8'));
	return Array.isArray(parsed) ? parsed[0] : parsed;
}

function loadFromContainer({ id, name }) {
	const exported = execSync(`docker exec ${CONTAINER} n8n export:workflow --all`, { encoding: 'utf-8' });
	const workflows = JSON.parse(exported);
	const workflow = id
		? workflows.find((w) => w.id === id)
		: workflows.find((w) => w.name === name);
	if (!workflow) {
		const available = workflows.map((w) => `${w.name} (${w.id})`).join(', ');
		throw new Error(`Workflow not found in ${CONTAINER}. Available: ${available}`);
	}
	return workflow;
}

function sanitizeNode(node) {
	const clean = { ...node };
	delete clean.webhookId; // instance-specific webhook registration, never portable

	if (clean.credentials) {
		clean.credentials = Object.fromEntries(
			Object.entries(clean.credentials).map(([type, cred]) => [type, { ...cred, id: PLACEHOLDER }]),
		);
	}
	return clean;
}

function sanitizeWorkflow(raw) {
	return {
		name: raw.name,
		active: false,
		nodes: (raw.nodes ?? []).map(sanitizeNode),
		connections: raw.connections ?? {},
		settings: { executionOrder: raw.settings?.executionOrder ?? 'v1' },
		meta: { templateCredsSetupCompleted: true },
		pinData: {},
	};
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.name && !args.id && !args.file) {
		console.error('Usage: node scripts/create-template.mjs (--name "<workflow name>" | --id <workflowId> | --file <path>) [--out <filename>.json]');
		process.exit(1);
	}

	const raw = args.file ? loadFromFile(args.file) : loadFromContainer({ id: args.id, name: args.name });
	const clean = sanitizeWorkflow(raw);

	const credentialIds = clean.nodes.flatMap((n) => Object.values(n.credentials ?? {}).map((c) => c.id));
	if (credentialIds.length === 0) {
		console.warn(
			'Warning: no credentialed nodes found. tests/workflow-templates.test.ts requires at least one ' +
				`node with a "${PLACEHOLDER}" credential id — this template will fail that check as-is.`,
		);
	}

	const outFile = args.out ?? `${toKebabCase(clean.name)}.json`;
	const outPath = join(TEMPLATES_DIR, outFile);
	if (!existsSync(TEMPLATES_DIR)) {
		console.error(`Templates directory not found: ${TEMPLATES_DIR}`);
		process.exit(1);
	}

	writeFileSync(outPath, `${JSON.stringify(clean, null, 2)}\n`);
	console.log(`Wrote ${outPath}`);
	console.log('Run `npm test` to confirm it passes tests/workflow-templates.test.ts.');
}

main();
