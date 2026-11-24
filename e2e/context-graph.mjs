#!/usr/bin/env node
// The Context Graph end to end: a real n8n (docker compose) against the SDK
// dev-server, with the workflows imported by scripts/setup.mjs.
//
// Starts, on the host, small proxies in front of the dev-server laid out as a
// deployed Context Graph is: Ingest, Delivery and storage on hosts of their
// own, and each key checked by its own service.
//   :5200  Delivery. Checks the Delivery API Key and can answer a read 503
//          once (to prove the node's retry through n8n's real errors).
//   :5201  Ingest. Checks the Ingest API Key, and signs the upload URL for
//          the storage host with the header Azure Blob Storage requires.
//   :5202  storage, the signed upload URL's host. Refuses an upload with an
//          API key, without the reservation's headers or without a fixed
//          length, as Azure Blob Storage does.
//   :5500  the "source system": the export the round-trip template fetches.
// The dev-server itself listens on loopback only, with an empty graph each run.
// With --serve, :5200 also serves Ingest and checks no key, as the dev-server
// does, for running the templates by hand with setup.mjs's defaults.
//
// Then runs each case with scripts/execute-workflow.mjs and checks the
// execution it reports. Exits non-zero on the first failed check.
//
// Usage (Node 26, after `npm install` in this folder; n8n up and setup.mjs run):
//   node e2e/context-graph.mjs           run every case, then stop
//   node e2e/context-graph.mjs --serve   only serve the graph and the export
//
// The credential must point at this layout: run setup.mjs with
//   CONTEXT_GRAPH_INGEST_URL=http://host.docker.internal:5201
//   CONTEXT_GRAPH_INGEST_API_KEY=e2e-ingest-key
//   CONTEXT_GRAPH_DELIVERY_API_KEY=e2e-delivery-key
// (these key values are the defaults here; set the same env vars for both).
//
// Optional env vars:
//   N8N_CONTAINER, N8N_URL  passed on to execute-workflow.mjs
//   E2E_HOST                where :5200-:5202 and :5500 listen (default 0.0.0.0, so
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
const INGEST_PORT = 5201;
const STORAGE_PORT = 5202;
const EXPORT_PORT = 5500;
const DEV_SERVER_PORT = 5199;
const SERVE = process.argv.includes('--serve');

// Test values, not secrets: the keys the e2e credential carries.
const INGEST_KEY = process.env.CONTEXT_GRAPH_INGEST_API_KEY || 'e2e-ingest-key';
const DELIVERY_KEY = process.env.CONTEXT_GRAPH_DELIVERY_API_KEY || 'e2e-delivery-key';
if (!SERVE && INGEST_KEY === DELIVERY_KEY) {
	console.error('The Ingest and Delivery API Keys must differ, so the run proves each goes only to its own service.');
	process.exit(2);
}

const ROUND_TRIP = 'Context Graph · Round trip (upload an export, read it back)';
const DELIVERY = 'Context Graph · E2E delivery reads';

// --- The graph ---------------------------------------------------------------

const dataDir = mkdtempSync(join(tmpdir(), 'n8n-e2e-graph-'));
const devServer = await createDevServer(schema, {
	port: DEV_SERVER_PORT,
	dataDir,
	sources,
});

// The proxies keep the Host header, so the upload URL the dev-server signs
// names the address n8n used (host.docker.internal:5201), which n8n can reach.
let shedNext = null; // headers for the next delivery read's 503, or null
let ingestKey = INGEST_KEY; // the key Ingest accepts; a case changes it to reject the credential's
let forbidIngest = false; // answer every Ingest request a bare 403, as an Ingest URL that doesn't admit the address
const seen = []; // every request through the proxies: { at, method, path, status, key, ... }
const DELIVERY_READ = /^\/(v1\/[^/]+\/|query\/v1\/|shapes\/v1\/)/;
const INGEST_ROUTE = /^\/v1\/(entities$|sources\/)/;
const UPLOAD_ROUTE = /^\/_artifacts\//;

/** Answers with a problem body, as the platform's services do. */
function problem(res, status, title, detail, headers = {}) {
	res.writeHead(status, { 'content-type': 'application/problem+json', ...headers });
	res.end(JSON.stringify({ title, status, detail }));
}

/**
 * Sends the request on to the dev-server. `rewrite`, when given, gets the
 * parsed JSON body of the answer and returns the body to send instead.
 */
function forward(req, res, entry, rewrite) {
	const upstream = request(
		{ host: '127.0.0.1', port: DEV_SERVER_PORT, method: req.method, path: req.url, headers: req.headers },
		(up) => {
			entry.status = up.statusCode;
			seen.push(entry);
			const json = String(up.headers['content-type'] ?? '').includes('json');
			if (!rewrite || !json) {
				res.writeHead(up.statusCode, up.headers);
				up.pipe(res);
				return;
			}
			const chunks = [];
			up.on('data', (chunk) => chunks.push(chunk));
			up.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf-8');
				let body = raw;
				try {
					body = JSON.stringify(rewrite(JSON.parse(raw)));
				} catch {
					// Not JSON after all: sent as it came.
				}
				const headers = { ...up.headers };
				delete headers['content-length'];
				delete headers['transfer-encoding'];
				res.writeHead(up.statusCode, { ...headers, 'content-length': Buffer.byteLength(body) });
				res.end(body);
			});
		},
	);
	upstream.on('error', (error) => {
		res.writeHead(502);
		res.end(String(error));
	});
	req.pipe(upstream);
}

const keyOf = (req) => req.headers['x-api-key'];

// Delivery. Deployed Delivery answers 401 to a key it doesn't know, before the route.
const delivery = createServer((req, res) => {
	const entry = { at: 'delivery', method: req.method, path: req.url, key: keyOf(req) };
	if (SERVE) return forward(req, res, entry);
	if (INGEST_ROUTE.test(req.url) || UPLOAD_ROUTE.test(req.url)) {
		seen.push({ ...entry, status: 404 });
		return problem(res, 404, `Not an Ingest URL: the e2e serves Ingest on :${INGEST_PORT}`, 'Run scripts/setup.mjs with CONTEXT_GRAPH_INGEST_URL set as e2e/context-graph.mjs says.');
	}
	if (entry.key !== DELIVERY_KEY) {
		seen.push({ ...entry, status: 401 });
		return problem(res, 401, 'Unauthorized', 'Not the Delivery API Key.', { 'www-authenticate': 'ApiKey' });
	}
	if (shedNext && DELIVERY_READ.test(req.url)) {
		const headers = shedNext;
		shedNext = null;
		seen.push({ ...entry, status: 503 });
		return problem(res, 503, 'Service Unavailable', 'Shed by the e2e proxy.', headers);
	}
	forward(req, res, entry);
});

// Ingest. The upload URL in a reservation is moved to the storage host, with
// the header Azure Blob Storage requires on it (deployed ingest names it).
const ingest = createServer((req, res) => {
	const entry = { at: 'ingest', method: req.method, path: req.url, key: keyOf(req) };
	if (!INGEST_ROUTE.test(req.url)) {
		seen.push({ ...entry, status: 404 });
		return problem(res, 404, 'Not Found', 'Not an Ingest route.');
	}
	if (forbidIngest) {
		seen.push({ ...entry, status: 403 });
		res.writeHead(403, { 'content-type': 'text/plain' });
		return res.end('Forbidden');
	}
	if (entry.key !== ingestKey) {
		seen.push({ ...entry, status: 401 });
		res.writeHead(401);
		return res.end();
	}
	forward(req, res, entry, (body) => {
		if (typeof body?.upload?.url !== 'string') return body;
		const url = new URL(body.upload.url);
		url.port = String(STORAGE_PORT);
		return { ...body, upload: { ...body.upload, url: url.toString(), headers: { ...body.upload.headers, 'x-ms-blob-type': 'BlockBlob' } } };
	});
});

// Storage: what Azure Blob Storage refuses on a signed Put Blob, refused here too.
const storage = createServer((req, res) => {
	const entry = {
		at: 'storage',
		method: req.method,
		path: req.url.replace(/token=[^&]*/, 'token=…'),
		key: keyOf(req),
		blobType: req.headers['x-ms-blob-type'],
		length: req.headers['content-length'],
		chunked: /chunked/i.test(String(req.headers['transfer-encoding'] ?? '')),
	};
	const refuse = (status, why) => {
		seen.push({ ...entry, status, why });
		res.writeHead(status, { 'content-type': 'application/xml' });
		res.end(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${why}</Code></Error>`);
	};
	if (req.method !== 'PUT' || !UPLOAD_ROUTE.test(req.url)) return refuse(404, 'ResourceNotFound');
	// The signature is the credential; a key on a request to storage has leaked.
	if (entry.key !== undefined) return refuse(403, 'ApiKeySentToStorage');
	if (entry.blobType !== 'BlockBlob') return refuse(400, 'MissingRequiredHeader');
	if (entry.chunked || entry.length === undefined) return refuse(411, 'MissingContentLengthHeader');
	forward(req, res, entry);
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

const servers = [
	[delivery, GRAPH_PORT],
	[ingest, INGEST_PORT],
	[storage, STORAGE_PORT],
	[exportsServer, EXPORT_PORT],
];
for (const [server, port] of servers) await new Promise((resolve) => server.listen(port, HOST, resolve));
console.log(
	`Delivery on ${HOST}:${GRAPH_PORT}${SERVE ? ' (Ingest too, no key check)' : ''}, Ingest on :${INGEST_PORT}, storage on :${STORAGE_PORT}, exports on :${EXPORT_PORT}`,
);

async function stop() {
	for (const [server] of servers) server.close();
	await devServer.stop();
	rmSync(dataDir, { recursive: true, force: true });
}

if (SERVE) {
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
	seen.length = 0;
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
	// Laid out as a deployed Context Graph: each key to its own service only,
	// and the file to storage with the signed URL alone.
	const at = (where) => seen.filter((r) => r.at === where);
	const ingestCalls = at('ingest').map((r) => `${r.method} ${r.path} ${r.status}`);
	check(at('ingest').length >= 3 && at('ingest').every((r) => r.key === INGEST_KEY && r.status < 300), `reserve, commit and status went to the Ingest URL with the Ingest API Key (${ingestCalls.join('; ')})`);
	const [put, ...morePuts] = at('storage');
	check(put?.method === 'PUT' && put.status < 300 && morePuts.length === 0, `the file went once to the storage host (${put?.method} ${put?.path} ${put?.status}${put?.why ? ` ${put.why}` : ''})`);
	check(put.key === undefined && put.blobType === 'BlockBlob' && put.length === String(complete.body.length) && !put.chunked, `with the reservation's x-ms-blob-type, a fixed Content-Length (${put.length}) and no API key`);
	check(at('delivery').length >= 1 && at('delivery').every((r) => r.key === DELIVERY_KEY && r.status === 200), `the read-out went to the Delivery URL with the Delivery API Key (${at('delivery').map((r) => r.path).join('; ')})`);

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

	// 5. A key the deployed Ingest URL doesn't accept (wrong or revoked): the
	// run fails at the reservation with the node's own words, nothing uploaded.
	console.log('\n[deployed] Ingest rejects the Ingest API Key');
	publish('complete');
	seen.length = 0;
	ingestKey = 'another-key';
	try {
		run = await runWorkflow(ROUND_TRIP);
	} finally {
		ingestKey = INGEST_KEY;
	}
	check(run.status === 'error', `the run fails (status ${run.status})`);
	check(run.error?.includes('The API key was rejected by the Ingest URL.'), `the run's error says the Ingest URL rejected the key (${run.error})`);
	check(!seen.some((r) => r.at === 'storage'), 'nothing reached storage');

	// 6. An Ingest URL that admits only listed addresses answers any other a
	// bare 403 before the key is read. The error names that as well as scope.
	console.log("\n[deployed] Ingest doesn't admit n8n's address");
	publish('complete');
	forbidIngest = true;
	try {
		run = await runWorkflow(ROUND_TRIP);
	} finally {
		forbidIngest = false;
	}
	check(run.status === 'error', `the run fails (status ${run.status})`);
	check(run.error?.includes("doesn't accept requests from this n8n's address"), `the run's error names the address as well as the key's scope (${run.error})`);
}
