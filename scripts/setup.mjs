#!/usr/bin/env node
// Sets up Enterspeed and other credentials in a running n8n container and
// imports all workflow templates with the credential IDs substituted in memory.
//
// Usage:
//   node scripts/setup.mjs
//
// Required env vars (loaded from .env if present):
//   ENTERSPEED_SOURCE_API_KEY
//   ENTERSPEED_ENVIRONMENT_API_KEY
//   N8N_CONTAINER  (default: n8n-nodes-enterspeed-n8n-1)
//
// Optional env vars:
//   CONTENTFUL_SPACE_ID
//   CONTENTFUL_DELIVERY_TOKEN
//   CONTENTFUL_PREVIEW_TOKEN
//   CONTEXT_GRAPH_INGEST_API_KEY    (default: dev-server, which ignores the key)
//   CONTEXT_GRAPH_DELIVERY_API_KEY  (default: dev-server, which ignores the key)
//   CONTEXT_GRAPH_INGEST_URL        (default: http://host.docker.internal:5200, the local dev-server)
//   CONTEXT_GRAPH_DELIVERY_URL      (default: http://host.docker.internal:5200)
//   CONTEXT_GRAPH_MANIFEST_VERSION  (default: 1.0.0)
//   CONTEXT_GRAPH_WEBHOOK_SECRET    the trigger's signing secret (default: a new
//                                   random one when the credential is created,
//                                   for the local dev-server; kept on re-runs)
//   OPENAI_API_KEY                  (default: stub, which the e2e stand-in accepts)
//   OPENAI_BASE_URL                 (default: http://host.docker.internal:5600/v1,
//                                   the e2e stand-in chat model)
//   N8N_WORKFLOW_DIRS               (default: workflows/templates) comma-separated
//                                   folders to import, relative to the repo root;
//                                   the e2e job adds e2e/workflows

import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Load .env if present
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  const content = readFileSync(envFile, 'utf-8').replace(/\r\n/g, '\n');
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim();
  }
}

const SOURCE_KEY = process.env.ENTERSPEED_SOURCE_API_KEY;
const ENV_KEY = process.env.ENTERSPEED_ENVIRONMENT_API_KEY;
const CONTENTFUL_SPACE_ID = process.env.CONTENTFUL_SPACE_ID;
const CONTENTFUL_DELIVERY_TOKEN = process.env.CONTENTFUL_DELIVERY_TOKEN;
const CONTENTFUL_PREVIEW_TOKEN = process.env.CONTENTFUL_PREVIEW_TOKEN;
const CONTAINER = process.env.N8N_CONTAINER ?? 'n8n-nodes-enterspeed-n8n-1';

if (!SOURCE_KEY) { console.error('Error: ENTERSPEED_SOURCE_API_KEY is required'); process.exit(1); }
if (!ENV_KEY)    { console.error('Error: ENTERSPEED_ENVIRONMENT_API_KEY is required'); process.exit(1); }

const hasContentful = CONTENTFUL_SPACE_ID && CONTENTFUL_DELIVERY_TOKEN && CONTENTFUL_PREVIEW_TOKEN;
if (!hasContentful && (CONTENTFUL_SPACE_ID || CONTENTFUL_DELIVERY_TOKEN || CONTENTFUL_PREVIEW_TOKEN)) {
  console.warn('Warning: partial Contentful config found — all of CONTENTFUL_SPACE_ID, CONTENTFUL_DELIVERY_TOKEN, CONTENTFUL_PREVIEW_TOKEN are required. Skipping Contentful credential setup.');
}

// Check if credentials already exist.
// n8n's CLI can print startup notices (e.g. telemetry status) to stdout ahead
// of the JSON payload, so parse from the first '[' rather than the raw output.
let exportedRaw;
try {
  exportedRaw = execSync(`docker exec ${CONTAINER} n8n export:credentials --all`, { encoding: 'utf-8' });
  exportedRaw = exportedRaw.slice(exportedRaw.indexOf('['));
} catch {
  exportedRaw = '[]';
}
const existing = JSON.parse(exportedRaw);
const cred = existing.find((c) => c.name === 'Enterspeed account' && c.type === 'enterspeedApi');

// Reuse the existing credential's id so re-running this script (e.g. after
// rotating the keys in .env) updates it in place instead of creating a
// duplicate — n8n's import:credentials upserts by id.
const credentialId = cred?.id ?? crypto.randomUUID();
console.log(cred ? `Updating Enterspeed credential (ID: ${credentialId})...` : 'Creating Enterspeed credential...');

const credentials = [{
  id: credentialId,
  name: 'Enterspeed account',
  type: 'enterspeedApi',
  data: { sourceApiKey: SOURCE_KEY, environmentApiKey: ENV_KEY },
}];

// Set up Contentful credential if all required keys are provided
let contentfulCredentialId;
if (hasContentful) {
  const contentfulCred = existing.find((c) => c.name === 'Contentful account' && c.type === 'contentfulApi');
  contentfulCredentialId = contentfulCred?.id ?? crypto.randomUUID();
  console.log(contentfulCred ? `Updating Contentful credential (ID: ${contentfulCredentialId})...` : 'Creating Contentful credential...');

  credentials.push({
    id: contentfulCredentialId,
    name: 'Contentful account',
    type: 'contentfulApi',
    data: { spaceId: CONTENTFUL_SPACE_ID, ContentDeliveryaccessToken: CONTENTFUL_DELIVERY_TOKEN, ContentPreviewaccessToken: CONTENTFUL_PREVIEW_TOKEN },
  });
}

// The Context Graph credential defaults to the local dev-server, which needs
// no real key, so it is always set up.
const contextGraphCred = existing.find(
  (c) => c.name === 'Enterspeed Context Graph account' && c.type === 'enterspeedContextGraphApi',
);
const contextGraphCredentialId = contextGraphCred?.id ?? crypto.randomUUID();
console.log(contextGraphCred
  ? `Updating Enterspeed Context Graph credential (ID: ${contextGraphCredentialId})...`
  : 'Creating Enterspeed Context Graph credential...');

credentials.push({
  id: contextGraphCredentialId,
  name: 'Enterspeed Context Graph account',
  type: 'enterspeedContextGraphApi',
  data: {
    ingestUrl: process.env.CONTEXT_GRAPH_INGEST_URL || 'http://host.docker.internal:5200',
    ingestApiKey: process.env.CONTEXT_GRAPH_INGEST_API_KEY || 'dev-server',
    deliveryUrl: process.env.CONTEXT_GRAPH_DELIVERY_URL || 'http://host.docker.internal:5200',
    deliveryApiKey: process.env.CONTEXT_GRAPH_DELIVERY_API_KEY || 'dev-server',
    manifestVersion: process.env.CONTEXT_GRAPH_MANIFEST_VERSION || '1.0.0',
  },
});

// The Context Graph trigger's credential: one webhook subscription's signing
// secret. Against the dev-server any well-formed secret works, as long as the
// dev-server signs with the same one (the e2e reads it back from n8n).
const webhookCred = existing.find(
  (c) => c.name === 'Enterspeed Context Graph webhook' && c.type === 'enterspeedContextGraphWebhookApi',
);
const webhookCredentialId = webhookCred?.id ?? crypto.randomUUID();
if (process.env.CONTEXT_GRAPH_WEBHOOK_SECRET || !webhookCred) {
  console.log(webhookCred
    ? `Updating Enterspeed Context Graph webhook credential (ID: ${webhookCredentialId})...`
    : 'Creating Enterspeed Context Graph webhook credential...');
  credentials.push({
    id: webhookCredentialId,
    name: 'Enterspeed Context Graph webhook',
    type: 'enterspeedContextGraphWebhookApi',
    data: {
      signingSecret: process.env.CONTEXT_GRAPH_WEBHOOK_SECRET || `whsec_${randomBytes(32).toString('base64')}`,
    },
  });
}

// The chat model's credential. The default is the e2e's stand-in model, which
// answers without calling a real one; set both vars for a real model.
const openAiCred = existing.find((c) => c.name === 'OpenAI account' && c.type === 'openAiApi');
const openAiCredentialId = openAiCred?.id ?? crypto.randomUUID();
console.log(openAiCred ? `Updating OpenAI credential (ID: ${openAiCredentialId})...` : 'Creating OpenAI credential...');
credentials.push({
  id: openAiCredentialId,
  name: 'OpenAI account',
  type: 'openAiApi',
  data: {
    apiKey: process.env.OPENAI_API_KEY || 'stub',
    url: process.env.OPENAI_BASE_URL || 'http://host.docker.internal:5600/v1',
  },
});

const importResult = execSync(
  `docker exec -i ${CONTAINER} n8n import:credentials --input=/dev/stdin`,
  { input: JSON.stringify(credentials), encoding: 'utf-8' },
);
console.log(importResult.trim());
console.log(`Enterspeed credential ready with ID: ${credentialId}`);
console.log(`Enterspeed Context Graph credential ready with ID: ${contextGraphCredentialId}`);
console.log(`Enterspeed Context Graph webhook credential ready with ID: ${webhookCredentialId}`);
console.log(`OpenAI credential ready with ID: ${openAiCredentialId}`);
if (hasContentful) {
  console.log(`Contentful credential ready with ID: ${contentfulCredentialId}`);
}

// Maps each known credential placeholder to the env vars that supply it, so
// a leftover placeholder (credential not configured in .env) can be reported
// by name instead of importing a workflow with a broken credential ID.
const REQUIRED_ENV_VARS_BY_PLACEHOLDER = {
  __ENTERSPEED_CREDENTIAL_ID__: ['ENTERSPEED_SOURCE_API_KEY', 'ENTERSPEED_ENVIRONMENT_API_KEY'],
  __CONTENTFUL_CREDENTIAL_ID__: ['CONTENTFUL_SPACE_ID', 'CONTENTFUL_DELIVERY_TOKEN', 'CONTENTFUL_PREVIEW_TOKEN'],
};
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+_CREDENTIAL_ID__/g;

// Import each template with the placeholder substituted in memory.
const workflowDirs = (process.env.N8N_WORKFLOW_DIRS || 'workflows/templates')
  .split(',')
  .map((dir) => dir.trim())
  .filter(Boolean);
const templates = workflowDirs.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f)),
);

for (const file of templates) {
  let templateContent = readFileSync(join(ROOT, file), 'utf-8')
    .replaceAll('__ENTERSPEED_CREDENTIAL_ID__', credentialId)
    .replaceAll('__ENTERSPEED_CONTEXT_GRAPH_CREDENTIAL_ID__', contextGraphCredentialId)
    .replaceAll('__ENTERSPEED_CONTEXT_GRAPH_WEBHOOK_CREDENTIAL_ID__', webhookCredentialId)
    .replaceAll('__OPENAI_CREDENTIAL_ID__', openAiCredentialId);

  if (hasContentful) {
    templateContent = templateContent.replaceAll('__CONTENTFUL_CREDENTIAL_ID__', contentfulCredentialId);
  }

  const remaining = Array.from(new Set(templateContent.match(PLACEHOLDER_PATTERN) ?? []));
  if (remaining.length > 0) {
    for (const placeholder of remaining) {
      const envVars = REQUIRED_ENV_VARS_BY_PLACEHOLDER[placeholder];
      console.warn(
        envVars
          ? `Skipping ${file}: ${placeholder} left unsubstituted — set ${envVars.join(', ')} in .env.`
          : `Skipping ${file}: ${placeholder} left unsubstituted — no known env vars for this credential.`,
      );
    }
    continue;
  }

  console.log(`Importing ${file}...`);
  const template = JSON.parse(templateContent);
  // n8n import requires a workflow id
  template.id = crypto.randomUUID();
  const patched = JSON.stringify(template);
  execSync(`docker exec -i ${CONTAINER} n8n import:workflow --input=/dev/stdin`, {
    input: patched,
    encoding: 'utf-8',
  });
}

console.log('Done. Open http://localhost:5678 to get started.');
