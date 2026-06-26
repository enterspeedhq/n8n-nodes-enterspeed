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

// Create the credential via the n8n CLI inside the container.
console.log('Creating Enterspeed credential...');
const data = JSON.stringify({ sourceApiKey: SOURCE_KEY, environmentApiKey: ENV_KEY });
const result = execSync(
  `docker exec ${CONTAINER} n8n credentials:create --type enterspeedApi --name "Enterspeed account" --data '${data}'`,
  { encoding: 'utf-8' },
);

const match = result.match(/id[:\s]+([A-Za-z0-9]+)/i);
if (!match) {
  console.error('Error: could not parse credential ID from output:\n', result);
  process.exit(1);
}
const credentialId = match[1];
console.log(`Credential created with ID: ${credentialId}`);

// Import each template with the placeholder substituted in memory.
const templatesDir = join(ROOT, 'workflows', 'templates');
const templates = readdirSync(templatesDir).filter((f) => f.endsWith('.json'));

for (const file of templates) {
  console.log(`Importing ${file}...`);
  const patched = readFileSync(join(templatesDir, file), 'utf-8')
    .replaceAll('__ENTERSPEED_CREDENTIAL_ID__', credentialId);
  execSync(`docker exec -i ${CONTAINER} n8n import:workflow --input=/dev/stdin`, {
    input: patched,
    encoding: 'utf-8',
  });
}

console.log('Done. Open http://localhost:5678 to get started.');
