#!/usr/bin/env node
// The Context Graph end to end: a real n8n (docker compose) against the SDK
// dev-server, with the workflows imported by scripts/setup.mjs.
//
// Starts, on the host:
//   :5200  the graph, as the credential setup.mjs creates expects it. A small
//          proxy in front of the dev-server, which can answer a delivery read
//          503 once (to prove the node's retry through n8n's real errors).
//   :5500  the "source system": the export the round-trip template fetches.
// The dev-server itself listens on loopback only, with an empty graph each run.
//
// Then runs each case with scripts/execute-workflow.mjs and checks the
// execution it reports. Exits non-zero on the first failed check.
//
// Usage (Node 26, after `npm install` in this folder; n8n up and setup.mjs run):
//   node e2e/context-graph.mjs           run every case, then stop
//   node e2e/context-graph.mjs --serve   only serve the graph and the export
//
// Optional env vars:
//   N8N_CONTAINER, N8N_URL  passed on to execute-workflow.mjs
//   E2E_HOST                where :5200 and :5500 listen (default 0.0.0.0, so
//                           the n8n container reaches them). No authentication:
//                           test data only, on a network you trust.

import { createDevServer } from '@enterspeed/dev-server';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema, sources } from './schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HOST = process.env.E2E_HOST ?? '0.0.0.0';
const GRAPH_PORT = 5200;
const EXPORT_PORT = 5500;
const DEV_SERVER_PORT = 5199;

const ROUND_TRIP = 'Context Graph · Round trip (upload an export, read it back)';
const DELIVERY = 'Context Graph · E2E delivery reads';

// --- The graph ---------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'n8n-e2e-graph-'));
const devServer = await createDevServer(schema, {
	port: DEV_SERVER_PORT,
	dataDir,
	sources,
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
console.log(`Graph on ${HOST}:${GRAPH_PORT}, exports on ${HOST}:${EXPORT_PORT}`);

async function stop() {
	proxy.close();
	exportsServer.close();
	await devServer.stop();
	rmSync(dataDir, { recursive: true, force: true });
}

if (process.argv.includes('--serve')) {
	publish('complete');
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

/** The JSON of every item a node output in the run, across its runs. */
function output(execution, node) {
	const runs = execution.nodes[node];
	if (!runs) return null;
	return runs.flatMap((run) => (run.data?.main ?? []).flat().map((item) => item.json));
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
}
