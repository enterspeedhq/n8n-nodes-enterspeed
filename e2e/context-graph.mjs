#!/usr/bin/env node
// The Context Graph end to end: a real n8n (docker compose) against the SDK
// dev-server, with the workflows imported by scripts/setup.mjs.
//
// Starts, on the host:
//   :5200  the graph, as the credential setup.mjs creates expects it. A small
//          proxy in front of the dev-server, which can answer a delivery read
//          503 once (to prove the node's retry through n8n's real errors).
//   :5500  the "source system": the export the round-trip template fetches.
//   :5600  a stand-in chat model (OpenAI's chat completions), so the enrichment
//          template runs without calling a real model.
// The dev-server itself listens on loopback only, with an empty graph each run.
// Its outbound webhook goes to a relay on loopback, which passes a delivery on
// to the enrichment template's trigger only while a case listens, unchanged
// (headers and bytes, so its signature still verifies).
//
// Then runs each case with scripts/execute-workflow.mjs and checks the
// execution it reports. Exits non-zero on the first failed check.
//
// Usage (Node 26, after `npm install` in this folder; n8n up and setup.mjs run):
//   node e2e/context-graph.mjs           run every case, then stop
//   node e2e/context-graph.mjs --serve   only serve the graph and the export
//
// Optional env vars:
//   N8N_CONTAINER, N8N_URL  passed on to execute-workflow.mjs, and used to
//                           read the trigger's signing secret and the runs
//   E2E_HOST                where :5200, :5500 and :5600 listen (default 0.0.0.0, so
//                           the n8n container reaches them). No authentication:
//                           test data only, on a network you trust.

import { createDevServer } from '@enterspeed/dev-server';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, sources } from './schema.mjs';
import { signIn, summarise } from '../scripts/n8n-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HOST = process.env.E2E_HOST ?? '0.0.0.0';
const GRAPH_PORT = 5200;
const EXPORT_PORT = 5500;
const DEV_SERVER_PORT = 5199;
const RELAY_PORT = 5201;
const MODEL_PORT = 5600;
const N8N_URL = process.env.N8N_URL ?? 'http://localhost:5678';
const CONTAINER = process.env.N8N_CONTAINER ?? 'n8n-nodes-enterspeed-n8n-1';

const ROUND_TRIP = 'Context Graph · Round trip (upload an export, read it back)';
const DELIVERY = 'Context Graph · E2E delivery reads';
const ENRICH = 'Context Graph · Enrich changed products into their own source';
// The enrichment template's trigger: its production URL, live once the workflow is published.
const ENRICH_WEBHOOK = `${N8N_URL}/webhook/0f6c2d4e-8a1b-4c3d-9e5f-000000014248/webhook`;

// The trigger's signing secret, as setup.mjs stored it in n8n, so the
// dev-server signs with the same one. Never printed.
function webhookSecret() {
	try {
		const raw = execSync(`docker exec ${CONTAINER} n8n export:credentials --all --decrypted 2>/dev/null`, {
			encoding: 'utf-8',
		});
		const credential = JSON.parse(raw.slice(raw.indexOf('['))).find(
			(c) => c.name === 'Enterspeed Context Graph webhook' && c.type === 'enterspeedContextGraphWebhookApi',
		);
		return credential?.data?.signingSecret;
	} catch {
		return undefined;
	}
}
const secret = webhookSecret();
if (!secret) console.warn('No Enterspeed Context Graph webhook credential in n8n: the dev-server sends no webhook.');

// --- The graph ---------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'n8n-e2e-graph-'));
const devServer = await createDevServer(schema, {
	port: DEV_SERVER_PORT,
	dataDir,
	sources,
	...(secret && { webhookUrl: `http://127.0.0.1:${RELAY_PORT}/`, webhookSecret: secret }),
});

// The relay: every delivery the dev-server sends, and whether it went on to n8n.
let listening = false; // pass deliveries on to the enrichment trigger
const deliveries = []; // { envelope, forwarded, status }

const relay = createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', async () => {
		const body = Buffer.concat(chunks);
		const delivery = { envelope: JSON.parse(body.toString('utf-8')), forwarded: listening, status: 200 };
		deliveries.push(delivery);
		if (listening) {
			const headers = Object.fromEntries(
				['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature']
					.filter((name) => req.headers[name] !== undefined)
					.map((name) => [name, req.headers[name]]),
			);
			try {
				const forwarded = await fetch(ENRICH_WEBHOOK, { method: 'POST', headers, body });
				delivery.status = forwarded.status;
			} catch {
				delivery.status = 502;
			}
		}
		res.writeHead(delivery.status);
		res.end();
	});
});

// --- The stand-in chat model ---------------------------------------------------

// Answers OpenAI's chat completions with a fixed sentence, so a run is
// deterministic, and refuses (400, which isn't retried) a prompt naming an
// "Unenrichable" product, so one entry's enrichment fails.
const prompts = []; // every prompt it was sent

const model = createServer((req, res) => {
	let body = '';
	req.on('data', (chunk) => (body += chunk));
	req.on('end', () => {
		if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
			res.writeHead(404);
			res.end();
			return;
		}
		const request = JSON.parse(body);
		const prompt = String(request.messages?.at(-1)?.content ?? '');
		prompts.push(prompt);
		res.setHeader('content-type', 'application/json');
		if (prompt.includes('Unenrichable')) {
			res.writeHead(400);
			res.end(JSON.stringify({ error: { message: 'The stand-in model refuses this product.', type: 'invalid_request_error', code: null } }));
			return;
		}
		const name = prompt.match(/"([^"]*)"/)?.[1] ?? 'it';
		res.writeHead(200);
		res.end(
			JSON.stringify({
				id: `chatcmpl-${prompts.length}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: request.model,
				choices: [
					{ index: 0, message: { role: 'assistant', content: `${name}: a stand-in description.` }, finish_reason: 'stop' },
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		);
	});
});

// The proxy keeps the Host header, so the upload URL the dev-server signs names
// the address n8n used (host.docker.internal:5200), which n8n can reach.
let shedNext = null; // headers for the next delivery read's 503, or null
const seen = []; // every request through the proxy: { method, path, status }
const DELIVERY_READ = /^\/(v1\/[^/]+\/|query\/v1\/|shapes\/v1\/)/;

const proxy = createServer((req, res) => {
	if (shedNext && DELIVERY_READ.test(req.url) && !req.url.startsWith('/v1/sources/') && req.url !== '/v1/entities') {
		const headers = shedNext;
		shedNext = null;
		seen.push({ method: req.method, path: req.url, status: 503 });
		res.writeHead(503, { 'content-type': 'application/problem+json', ...headers });
		res.end(JSON.stringify({ title: 'Service Unavailable', status: 503, detail: 'Shed by the e2e proxy.' }));
		return;
	}
	const upstream = request(
		{ host: '127.0.0.1', port: DEV_SERVER_PORT, method: req.method, path: req.url, headers: req.headers },
		(up) => {
			seen.push({ method: req.method, path: req.url, status: up.statusCode });
			res.writeHead(up.statusCode, up.headers);
			up.pipe(res);
		},
	);
	upstream.on('error', (error) => {
		res.writeHead(502);
		res.end(String(error));
	});
	req.pipe(upstream);
});

// --- The source system -------------------------------------------------------

let latest = null; // { file, body, asOf, rowCount }

function publish(drop) {
	const body = readFileSync(join(HERE, 'exports', drop, 'products.ndjson'));
	latest = {
		file: 'products.ndjson',
		body,
		// The export "started" now: each upload must be later than the last.
		asOf: new Date().toISOString(),
		// The source's own count: the lines that aren't blank.
		rowCount: body.toString('utf-8').split('\n').filter((line) => line.trim() !== '').length,
	};
	return latest;
}

const exportsServer = createServer((req, res) => {
	if (latest && req.url === '/exports/latest/exports.json') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ file: latest.file, asOf: latest.asOf, rowCount: latest.rowCount }));
	} else if (latest && req.url === `/exports/latest/${latest.file}`) {
		res.writeHead(200, { 'content-type': 'application/x-ndjson' });
		res.end(latest.body);
	} else {
		res.writeHead(404);
		res.end();
	}
});

await new Promise((resolve) => proxy.listen(GRAPH_PORT, HOST, resolve));
await new Promise((resolve) => exportsServer.listen(EXPORT_PORT, HOST, resolve));
await new Promise((resolve) => relay.listen(RELAY_PORT, '127.0.0.1', resolve));
await new Promise((resolve) => model.listen(MODEL_PORT, HOST, resolve));
console.log(`Graph on ${HOST}:${GRAPH_PORT}, exports on ${HOST}:${EXPORT_PORT}, chat model on ${HOST}:${MODEL_PORT}`);

async function stop() {
	proxy.close();
	exportsServer.close();
	relay.close();
	model.close();
	await devServer.stop();
	rmSync(dataDir, { recursive: true, force: true });
}

if (process.argv.includes('--serve')) {
	publish('complete');
	listening = true;
	console.log('Serving the "complete" export. Ctrl+C to stop.');
	const shutdown = async () => {
		await stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
} else {
	let failed = false;
	try {
		await runCases();
		console.log('\nAll Context Graph end-to-end checks passed.');
	} catch (error) {
		failed = true;
		console.error(`\nFAILED: ${error.message}`);
	} finally {
		await stop();
	}
	process.exit(failed ? 1 : 0);
}

// --- The cases ---------------------------------------------------------------

/**
 * Runs the workflow through execute-workflow.mjs; returns { status, error, nodes }.
 * Asynchronously: this process serves the graph and the export the run reads.
 */
async function runWorkflow(name) {
	const out = join(dataDir, 'execution.json');
	rmSync(out, { force: true });
	// A failed run exits non-zero and is reported in the execution file, checked below.
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(ROOT, 'scripts', 'execute-workflow.mjs')], {
			env: { ...process.env, N8N_WORKFLOW_NAME: name, N8N_EXECUTION_OUT: out },
			stdio: 'inherit',
		});
		child.on('error', reject);
		child.on('exit', resolve);
	});
	let execution;
	try {
		execution = JSON.parse(readFileSync(out, 'utf-8'));
	} catch {
		throw new Error(`"${name}" reported no execution`);
	}
	return execution;
}

/**
 * The JSON of every item a node output in the run, across its runs: on every
 * output, or only on output `branch` (a Filter's kept items are 0, an error
 * output is 1).
 */
function output(execution, node, branch) {
	const runs = execution.nodes[node];
	if (!runs) return null;
	return runs.flatMap((run) => {
		const outputs = run.data?.main ?? [];
		return (branch === undefined ? outputs : [outputs[branch]]).flatMap((items) => items ?? []).map((item) => item.json);
	});
}

function check(condition, message) {
	if (!condition) throw new Error(message);
	console.log(`  ok: ${message}`);
}

async function runCases() {
	// 1. A complete export: the upload lands and the read-out returns it.
	console.log('\n[round trip] a complete export');
	const complete = publish('complete');
	const sent = complete.body
		.toString('utf-8')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line).$id);
	let run = await runWorkflow(ROUND_TRIP);
	check(run.status === 'success', `the run succeeds (status ${run.status}${run.error ? `: ${run.error}` : ''})`);
	const [upload] = output(run, 'Upload the export') ?? [];
	check(upload?.state === 'drained', `the upload is drained (${upload?.state})`);
	check(upload?.drain?.result?.applied === sent.length, `every line was applied (${upload?.drain?.result?.applied}/${sent.length})`);
	const [readBack] = output(run, 'Read it back') ?? [];
	const ids = (readBack?.items ?? []).map((item) => item.$rawId).sort();
	check(ids.length > 0, `the read-out returns records (${ids.length})`);
	check(JSON.stringify(ids) === JSON.stringify([...sent].sort()), `the read-out returns exactly the uploaded records (${ids.join(', ')})`);

	// 2. A file with a malformed line: the platform's reason fails the run.
	console.log('\n[round trip] an export with a malformed line');
	publish('malformed');
	run = await runWorkflow(ROUND_TRIP);
	check(run.status === 'error', `the run fails (status ${run.status})`);
	const [line] = output(run, "The lines that didn't land") ?? [];
	check(typeof line?.reason === 'string' && line.reason !== '', `the graph names the line and its reason (line ${line?.number}, ${line?.outcome}: ${line?.reason})`);
	check(typeof run.error === 'string' && run.error.includes(line.reason), `the run's error carries the graph's reason (${run.error})`);
	check(output(run, 'Read it back') === null, 'nothing is read back');

	// 3. ETag revalidation: the second read with the stored ETag is a real 304.
	console.log('\n[delivery] ETag revalidation');
	run = await runWorkflow(DELIVERY);
	check(run.status === 'success', `the run succeeds (status ${run.status}${run.error ? `: ${run.error}` : ''})`);
	const [first] = output(run, 'Read a product') ?? [];
	check(first?.status === 200 && typeof first?.headers?.ETag === 'string', `the first read is a 200 with an ETag (${first?.status}, ${first?.headers?.ETag})`);
	const [second] = output(run, 'Read it again with its ETag') ?? [];
	check(second?.status === 304 && second?.body === null, `the second read is a 304 with no body (${second?.status})`);
	check(second?.headers?.ETag === first.headers.ETag, `the 304 carries the same ETag (${JSON.stringify(second?.headers)})`);

	// 4. A load-shed read: a real 503 keeps its retry headers through n8n's
	// error, so the node waits and sends the read once more.
	for (const headers of [{ 'Retry-After': '1' }, { 'X-Delivery-Retry-After-Ms': '300' }]) {
		const [header] = Object.keys(headers);
		console.log(`\n[delivery] a 503 with ${header} on the first read`);
		seen.length = 0;
		shedNext = headers;
		run = await runWorkflow(DELIVERY);
		check(shedNext === null, 'the proxy answered a read 503');
		check(run.status === 'success', `the run succeeds (status ${run.status}${run.error ? `: ${run.error}` : ''})`);
		const shed = seen.findIndex((r) => r.status === 503);
		const retried = seen[shed + 1];
		check(retried?.path === seen[shed].path && retried.status === 200, `the same read was sent again and answered 200 (${retried?.path} ${retried?.status})`);
	}

	await runEnrichmentCases();
}

// --- The enrichment template ---------------------------------------------------

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pushes records straight to the graph, as a source system would: one ingest, one commit. */
async function ingest(records) {
	const res = await fetch(`http://127.0.0.1:${DEV_SERVER_PORT}/v1/entities`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-ndjson' },
		body: records.map((record) => JSON.stringify(record)).join('\n'),
	});
	if (!res.ok) throw new Error(`The ingest was refused (${res.status}: ${await res.text()})`);
}

/** A shape as the graph serves it now, or null when there is none. */
async function shape(key) {
	const res = await fetch(`http://127.0.0.1:${DEV_SERVER_PORT}/shapes/v1/1.0.0/${key.split(':').join('/')}`);
	return res.status === 200 ? res.json() : null;
}

/** The workflow's finished executions after execution `after`, oldest first, each as summarise() gives it. */
async function executions(auth, workflowId, after = 0) {
	const filter = encodeURIComponent(JSON.stringify({ workflowId }));
	const list = await (await fetch(`${N8N_URL}/rest/executions?filter=${filter}&limit=50`, { headers: auth })).json();
	const finished = (list.data?.results ?? []).filter(
		(e) => Number(e.id) > after && !['new', 'running', 'waiting'].includes(e.status),
	);
	const runs = [];
	for (const { id, status } of finished.sort((a, b) => Number(a.id) - Number(b.id))) {
		const body = await (await fetch(`${N8N_URL}/rest/executions/${id}`, { headers: auth })).json();
		runs.push({ id, ...summarise(status, body.data) });
	}
	return runs;
}

/** The highest execution id n8n has, so a case counts only the runs after it. */
async function lastExecutionId(auth) {
	const list = await (await fetch(`${N8N_URL}/rest/executions?limit=1`, { headers: auth })).json();
	return Math.max(0, ...(list.data?.results ?? []).map((e) => Number(e.id)));
}

/**
 * Waits until the dev-server has sent `count` deliveries and n8n has finished
 * `count` runs after execution `after`, then a few seconds more, so a run a
 * later delivery would start has time to show up. Returns the runs after `after`.
 */
async function settle(auth, workflowId, after, count) {
	const until = Date.now() + 60_000;
	while (Date.now() < until) {
		if (deliveries.length >= count && (await executions(auth, workflowId, after)).length >= count) break;
		await sleep(1000);
	}
	await sleep(5000);
	return executions(auth, workflowId, after);
}

async function runEnrichmentCases() {
	if (!secret) throw new Error('No webhook credential in n8n, so the enrichment template cannot be checked');
	const auth = await signIn(N8N_URL);
	const workflows = (await (await fetch(`${N8N_URL}/rest/workflows`, { headers: auth })).json()).data ?? [];
	// The copy setup.mjs imported last, if it ran more than once on this n8n.
	const [workflow] = workflows
		.filter((w) => w.name === ENRICH)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	if (!workflow) throw new Error(`"${ENRICH}" is not imported`);
	const published = await fetch(`${N8N_URL}/rest/workflows/${workflow.id}/activate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...auth },
		body: JSON.stringify({ versionId: workflow.versionId }),
	});
	if (!published.ok) throw new Error(`Publishing "${ENRICH}" failed (${published.status}: ${await published.text()})`);
	try {
		await enrichmentCases(auth, workflow.id);
	} finally {
		listening = false;
		// Unpublished again, so a later setup.mjs import of the template can be published.
		await fetch(`${N8N_URL}/rest/workflows/${workflow.id}/deactivate`, { method: 'POST', headers: auth });
	}
}

async function enrichmentCases(auth, workflowId) {
	// The round trip's upload sent deliveries too; they were answered and dropped.
	deliveries.length = 0;
	listening = true;
	let after = await lastExecutionId(auth);

	// 5. One edit: one run enriches it, and the enrichment's own commit starts a
	// run that ends at the loop guard.
	console.log('\n[enrichment] one edit to a product');
	await ingest([{ $id: 'p-1', $type: 'product', $source: 'catalogue', id: 'p-1', name: 'Trail Runner Pro' }]);
	let runs = await settle(auth, workflowId, after, 2);
	check(deliveries.length === 2 && deliveries.every((d) => d.status === 200), `two deliveries reached the trigger, each answered 200 (${deliveries.map((d) => d.status).join(', ')})`);
	check(runs.length === 2 && runs.every((r) => r.status === 'success'), `two runs, both succeed (${runs.map((r) => r.status).join(', ')}${runs.find((r) => r.error) ? `: ${runs.find((r) => r.error).error}` : ''})`);
	const [enriching, guarded] = runs;
	const kept = output(enriching, 'Only changed products (loop guard)', 0) ?? [];
	check(kept.length === 1 && kept[0].key === '1.0.0:shape:ProductCard:productId:p-1', `the first run keeps only the product's ProductCard entry (${kept.map((k) => k.key).join(', ')})`);
	const [manifest, ...moreManifests] = output(enriching, 'Read the manifest') ?? [];
	check(moreManifests.length === 0 && manifest?.manifestVersion === '1.0.0', `it reads the credential's manifest once (${manifest?.manifestVersion})`);
	const ownManifest = output(enriching, "Only this workflow's manifest", 0) ?? [];
	check(ownManifest.length === 1 && ownManifest[0].key === kept[0].key, `and keeps the entry, which is under that manifest (${ownManifest.map((k) => k.key).join(', ')})`);
	const written = output(enriching, 'Write to the enrichment source') ?? [];
	check(written.length === 1 && written[0].accepted === true, `the first run writes exactly one record, accepted (${JSON.stringify(written)})`);
	check(prompts.length === 1 && prompts[0].includes('Trail Runner Pro'), `the model was asked once, about the edited product (${prompts.length})`);
	const entries = output(guarded, 'When the graph changes') ?? [];
	check(entries.length > 0 && entries.every((e) => e.key.includes(':shape:ProductEnrichment:')), `the second run is the enrichment's own commit (${entries.map((e) => e.key).join(', ')})`);
	check((output(guarded, 'Only changed products (loop guard)', 0) ?? []).length === 0, 'the loop guard keeps none of its entries');
	check(output(guarded, 'Write to the enrichment source') === null, 'the second run writes nothing, so no third run');
	const enrichment = await shape('ProductEnrichment:productId:p-1');
	check(enrichment?.description === 'Trail Runner Pro: a stand-in description.', `the enrichment source holds the description (${enrichment?.description})`);
	check((await shape('ProductEnrichment:productId:p-2')) === null, 'no other product was enriched');

	// 6. One commit, two products, one enrichment fails: the other is written and
	// the failure is reported, and the run doesn't fail.
	console.log('\n[enrichment] one of two enrichments fails');
	deliveries.length = 0;
	prompts.length = 0;
	after = await lastExecutionId(auth);
	await ingest([
		{ $id: 'p-4', $type: 'product', $source: 'catalogue', id: 'p-4', name: 'Harbour Loafer' },
		{ $id: 'p-5', $type: 'product', $source: 'catalogue', id: 'p-5', name: 'Unenrichable Boot' },
	]);
	runs = await settle(auth, workflowId, after, 2);
	check(runs.length === 2 && runs.every((r) => r.status === 'success'), `two more runs, both succeed (${runs.map((r) => r.status).join(', ')}${runs.find((r) => r.error) ? `: ${runs.find((r) => r.error).error}` : ''})`);
	const [mixed] = runs;
	const writes = output(mixed, 'Write to the enrichment source') ?? [];
	check(writes.length === 1 && writes[0].accepted === true && writes[0].id === 'p-4', `the run writes the product that enriched (${JSON.stringify(writes)})`);
	const [failure, ...more] = output(mixed, "Entries that weren't enriched") ?? [];
	check(more.length === 0 && failure?.key === '1.0.0:shape:ProductCard:productId:p-5' && typeof failure.error === 'string' && failure.error !== '', `it reports the one that didn't, with the error (${JSON.stringify(failure)})`);
	check((await shape('ProductEnrichment:productId:p-4'))?.description === 'Harbour Loafer: a stand-in description.', 'the enrichment source holds the written one');
	check((await shape('ProductEnrichment:productId:p-5')) === null, 'and nothing for the failed one');

	// 7. One commit, two products, the first read is answered 503 with no retry
	// header (so the node doesn't retry): the other is written, the failed read reported.
	console.log('\n[enrichment] one of two reads fails');
	deliveries.length = 0;
	prompts.length = 0;
	after = await lastExecutionId(auth);
	shedNext = {};
	await ingest([
		{ $id: 'p-6', $type: 'product', $source: 'catalogue', id: 'p-6', name: 'Meadow Sandal' },
		{ $id: 'p-7', $type: 'product', $source: 'catalogue', id: 'p-7', name: 'Summit Hiker' },
	]);
	runs = await settle(auth, workflowId, after, 2);
	check(shedNext === null, 'the proxy answered a read 503');
	check(runs.length === 2 && runs.every((r) => r.status === 'success'), `two more runs, both succeed (${runs.map((r) => r.status).join(', ')}${runs.find((r) => r.error) ? `: ${runs.find((r) => r.error).error}` : ''})`);
	const [reads] = runs;
	const [readFailure, ...otherFailures] = output(reads, "Entries that weren't enriched") ?? [];
	check(otherFailures.length === 0 && readFailure?.key === '1.0.0:shape:ProductCard:productId:p-6' && typeof readFailure.error === 'string' && readFailure.error !== '', `it reports the read that failed, with the error (${JSON.stringify(readFailure)})`);
	check(prompts.length === 1 && prompts[0].includes('Summit Hiker'), `the model was asked only about the product that was read (${prompts.length})`);
	const readWrites = output(reads, 'Write to the enrichment source') ?? [];
	check(readWrites.length === 1 && readWrites[0].accepted === true && readWrites[0].id === 'p-7', `the run writes the product that was read (${JSON.stringify(readWrites)})`);
	check((await shape('ProductEnrichment:productId:p-6')) === null, 'and nothing for the one whose read failed');
}
