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

import { execSync } from 'child_process';
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
let exportedRaw;
try {
  exportedRaw = execSync(`docker exec ${CONTAINER} n8n export:credentials --all`, { encoding: 'utf-8' });
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

const importResult = execSync(
  `docker exec -i ${CONTAINER} n8n import:credentials --input=/dev/stdin`,
  { input: JSON.stringify(credentials), encoding: 'utf-8' },
);
console.log(importResult.trim());
console.log(`Enterspeed credential ready with ID: ${credentialId}`);
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
const templatesDir = join(ROOT, 'workflows', 'templates');
const templates = readdirSync(templatesDir).filter((f) => f.endsWith('.json'));

for (const file of templates) {
  let templateContent = readFileSync(join(templatesDir, file), 'utf-8')
    .replaceAll('__ENTERSPEED_CREDENTIAL_ID__', credentialId);

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
