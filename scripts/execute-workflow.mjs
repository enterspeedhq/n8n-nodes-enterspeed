#!/usr/bin/env node
// Creates an n8n owner account (fresh instance only), signs in, triggers
// the most recently imported workflow, and polls until it completes.
//
// NOTE: This script uses n8n's internal /rest/* API, which is unversioned and
// private. The pinned image in docker-compose.yml keeps it stable — revisit
// these endpoints after any n8n image version bump.
//
// Usage:
//   node scripts/execute-workflow.mjs
//
// Optional env vars:
//   N8N_URL            (default: http://localhost:5678)
//   N8N_CONTAINER      (default: n8n-nodes-enterspeed-n8n-1)
//   N8N_WORKFLOW_NAME  (default: Fetch, Transform and Re-ingest)

import { execSync } from 'child_process';

const N8N_URL = process.env.N8N_URL ?? 'http://localhost:5678';
const CONTAINER = process.env.N8N_CONTAINER ?? 'n8n-nodes-enterspeed-n8n-1';
const WORKFLOW_NAME = process.env.N8N_WORKFLOW_NAME ?? 'Fetch, Transform and Re-ingest';
const EMAIL = 'runner@n8n.local';
const PASSWORD = 'N8nRunner99!';

async function post(path, body, headers = {}) {
  const res = await fetch(`${N8N_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

async function get(path, headers = {}) {
  const res = await fetch(`${N8N_URL}${path}`, { headers });
  return res;
}

// Set up owner account on a fresh instance (no-op if already exists).
console.log('Setting up n8n owner account...');
await post('/rest/owner/setup', { email: EMAIL, password: PASSWORD, firstName: 'CI', lastName: 'Runner' });

// Sign in.
console.log('Signing in...');
const loginRes = await post('/rest/login', { emailOrLdapLoginId: EMAIL, password: PASSWORD });
if (!loginRes.ok) {
  console.error('Login failed:', await loginRes.text());
  process.exit(1);
}
const cookie = loginRes.headers.get('set-cookie')?.match(/n8n-auth=[^;]+/)?.[0];
if (!cookie) {
  console.error('No auth cookie in login response');
  process.exit(1);
}
const authHeader = { Cookie: cookie };

// Find the workflow by name.
const exported = execSync(`docker exec ${CONTAINER} n8n export:workflow --all 2>/dev/null`, { encoding: 'utf-8' });
const workflows = JSON.parse(exported);
const workflow = workflows.find((w) => w.name === WORKFLOW_NAME);
if (!workflow) {
  console.error(`Workflow "${WORKFLOW_NAME}" not found. Available: ${workflows.map((w) => w.name).join(', ')}`);
  process.exit(1);
}
const workflowId = workflow.id;
console.log(`Triggering workflow: ${workflow.name} (${workflowId})`);

// Trigger execution.
const runRes = await post(
  `/rest/workflows/${workflowId}/run`,
  { runData: {}, startNodes: [], destinationNode: '' },
  authHeader,
);
const runBody = await runRes.json();
const execId = runBody.data?.executionId;
if (!execId) {
  console.error('No executionId in trigger response:', JSON.stringify(runBody));
  process.exit(1);
}
console.log(`Execution ID: ${execId}`);

// Poll until done.
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const statusRes = await get(`/rest/executions/${execId}`, authHeader);
  const statusBody = await statusRes.json();
  const status = statusBody.data?.status ?? statusBody.status;
  console.log(`Status: ${status}`);
  if (status === 'success') process.exit(0);
  if (status === 'error' || status === 'crashed') {
    console.error('Workflow execution failed');
    process.exit(1);
  }
}
console.error('Timed out waiting for workflow execution');
process.exit(1);
