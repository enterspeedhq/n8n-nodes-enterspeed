import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TEMPLATES_DIR = join(__dirname, '../workflows/templates');
const PLACEHOLDER = '__ENTERSPEED_CREDENTIAL_ID__';
const FAKE_ID = 'test-credential-id';

function loadTemplates() {
	return readdirSync(TEMPLATES_DIR)
		.filter((f) => f.endsWith('.json'))
		.map((f) => ({ name: f, raw: readFileSync(join(TEMPLATES_DIR, f), 'utf-8') }));
}

function substitute(raw: string, id: string) {
	return raw.replaceAll(PLACEHOLDER, id);
}

describe('workflow templates', () => {
	const templates = loadTemplates();

	it('templates directory contains at least one workflow', () => {
		expect(templates.length).toBeGreaterThan(0);
	});

	for (const { name, raw } of templates) {
		describe(name, () => {
			it('is valid JSON', () => {
				expect(() => JSON.parse(raw)).not.toThrow();
			});

			it('contains the credential placeholder', () => {
				expect(raw).toContain(PLACEHOLDER);
			});

			it('contains no real credential IDs (only the placeholder)', () => {
				const parsed = JSON.parse(raw);
				const json = JSON.stringify(parsed);
				// After removing placeholders nothing else looks like an n8n credential id
				// (alphanumeric, 16 chars) in a credential "id" field.
				const withoutPlaceholders = json.replaceAll(PLACEHOLDER, '');
				const credIdPattern = /"id":"[A-Za-z0-9]{16}"/g;
				expect(withoutPlaceholders.match(credIdPattern)).toBeNull();
			});

			it('produces valid JSON after substitution with no remaining placeholders', () => {
				const patched = substitute(raw, FAKE_ID);
				expect(() => JSON.parse(patched)).not.toThrow();
				expect(patched).not.toContain(PLACEHOLDER);
			});

			it('has the expected top-level workflow fields', () => {
				const [workflow] = JSON.parse(raw);
				expect(workflow).toHaveProperty('name');
				expect(workflow).toHaveProperty('nodes');
				expect(workflow).toHaveProperty('connections');
				expect(Array.isArray(workflow.nodes)).toBe(true);
			});

			it('has no personal export fields', () => {
				const [workflow] = JSON.parse(raw);
				expect(workflow.shared).toBeUndefined();
				expect(workflow.id).toBeUndefined();
				expect(workflow.versionId).toBeUndefined();
			});

			it('substitutes the credential id into all credential fields', () => {
				const [workflow] = JSON.parse(substitute(raw, FAKE_ID));
				const credIds = workflow.nodes
					.flatMap((n: { credentials?: Record<string, { id: string }> }) =>
						Object.values(n.credentials ?? {}).map((c) => c.id),
					)
					.filter(Boolean);
				expect(credIds.length).toBeGreaterThan(0);
				expect(credIds.every((id: string) => id === FAKE_ID)).toBe(true);
			});
		});
	}
});
