#!/usr/bin/env node
// Sets up the Enterspeed credential in a running n8n container and imports
// all workflow templates with the credential ID substituted in memory.
//
// Usage:
//   node scripts/setup.mjs
//
// Required env vars (loaded from .env if present):
//   ENTERSPEED_SOURCE_API_KEY
//   ENTERSPEED_ENVIRONMENT_API_KEY
//   N8N_CONTAINER  (default: n8n-nodes-enterspeed-n8n-1)

import { execSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim();
  }
}

const SOURCE_KEY = process.env.ENTERSPEED_SOURCE_API_KEY;
const ENV_KEY = process.env.ENTERSPEED_ENVIRONMENT_API_KEY;
const CONTAINER = process.env.N8N_CONTAINER ?? 'n8n-nodes-enterspeed-n8n-1';

if (!SOURCE_KEY) { console.error('Error: ENTERSPEED_SOURCE_API_KEY is required'); process.exit(1); }
if (!ENV_KEY)    { console.error('Error: ENTERSPEED_ENVIRONMENT_API_KEY is required'); process.exit(1); }

// Import the credential via the n8n CLI inside the container.
console.log('Creating Enterspeed credential...');
const credential = JSON.stringify([{
  id: crypto.randomUUID(),
  name: 'Enterspeed account',
  type: 'enterspeedApi',
  data: { sourceApiKey: SOURCE_KEY, environmentApiKey: ENV_KEY },
}]);
const importResult = execSync(
  `docker exec -i ${CONTAINER} n8n import:credentials --input=/dev/stdin`,
  { input: credential, encoding: 'utf-8' },
);
console.log(importResult.trim());

// Retrieve the credential ID by exporting and finding our credential.
const exported = execSync(
  `docker exec ${CONTAINER} n8n export:credentials --all`,
  { encoding: 'utf-8' },
);
const creds = JSON.parse(exported);
const cred = creds.find((c) => c.name === 'Enterspeed account' && c.type === 'enterspeedApi');
if (!cred) {
  console.error('Error: could not find imported credential in export');
  process.exit(1);
}
const credentialId = cred.id;
console.log(`Credential created with ID: ${credentialId}`);

// Import each template with the placeholder substituted in memory.
const templatesDir = join(ROOT, 'workflows', 'templates');
const templates = readdirSync(templatesDir).filter((f) => f.endsWith('.json'));

for (const file of templates) {
  console.log(`Importing ${file}...`);
  const template = JSON.parse(
    readFileSync(join(templatesDir, file), 'utf-8')
      .replaceAll('__ENTERSPEED_CREDENTIAL_ID__', credentialId),
  );
  // n8n import requires a workflow id
  template[0].id = crypto.randomUUID();
  const patched = JSON.stringify(template);
  execSync(`docker exec -i ${CONTAINER} n8n import:workflow --input=/dev/stdin`, {
    input: patched,
    encoding: 'utf-8',
  });
}

console.log('Done. Open http://localhost:5678 to get started.');
