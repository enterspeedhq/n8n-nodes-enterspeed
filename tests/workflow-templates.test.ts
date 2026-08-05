import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TEMPLATES_DIR = join(__dirname, '../workflows/templates');
// Templates reference credentials via placeholders like
// __ENTERSPEED_CREDENTIAL_ID__ or __CONTENTFUL_CREDENTIAL_ID__. Discovering
// them by pattern (rather than an enumerated list) means a template can
// introduce a new credential type without any change needed here.
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+_CREDENTIAL_ID__/g;

function loadTemplates() {
	return readdirSync(TEMPLATES_DIR)
		.filter((f) => f.endsWith('.json'))
		.map((f) => ({ name: f, raw: readFileSync(join(TEMPLATES_DIR, f), 'utf-8') }));
}

function findPlaceholders(raw: string): string[] {
	return Array.from(new Set(raw.match(PLACEHOLDER_PATTERN) ?? []));
}

function fakeIdFor(placeholder: string) {
	// __ENTERSPEED_CREDENTIAL_ID__ -> test-enterspeed-credential-id
	return `test-${placeholder.toLowerCase().replaceAll('_', '-').replace(/^-+|-+$/g, '')}`;
}

function substitute(raw: string) {
	return findPlaceholders(raw).reduce((acc, placeholder) => acc.replaceAll(placeholder, fakeIdFor(placeholder)), raw);
}

describe('workflow templates', () => {
	const templates = loadTemplates();

	it('templates directory contains at least one workflow', () => {
		expect(templates.length).toBeGreaterThan(0);
	});

	for (const { name, raw } of templates) {
		describe(name, () => {
			const placeholders = findPlaceholders(raw);

			it('is valid JSON', () => {
				expect(() => JSON.parse(raw)).not.toThrow();
			});

			it('contains at least one credential placeholder', () => {
				expect(placeholders.length).toBeGreaterThan(0);
			});

			it('contains no real credential IDs (only placeholders)', () => {
				const parsed = JSON.parse(raw);
				const json = JSON.stringify(parsed);
				// After removing placeholders nothing else looks like an n8n credential id
				// (alphanumeric, 16 chars) in a credential "id" field.
				const withoutPlaceholders = placeholders.reduce((acc, p) => acc.replaceAll(p, ''), json);
				const credIdPattern = /"id":"[A-Za-z0-9]{16}"/g;
				expect(withoutPlaceholders.match(credIdPattern)).toBeNull();
			});

			it('produces valid JSON after substitution with no remaining placeholders', () => {
				const patched = substitute(raw);
				expect(() => JSON.parse(patched)).not.toThrow();
				expect(patched.match(PLACEHOLDER_PATTERN)).toBeNull();
			});

			it('has the expected top-level workflow fields', () => {
				const workflow = JSON.parse(raw);
				expect(workflow).toHaveProperty('name');
				expect(workflow).toHaveProperty('nodes');
				expect(workflow).toHaveProperty('connections');
				expect(Array.isArray(workflow.nodes)).toBe(true);
			});

			it('has no personal export fields', () => {
				const workflow = JSON.parse(raw);
				expect(workflow.shared).toBeUndefined();
				expect(workflow.id).toBeUndefined();
				expect(workflow.versionId).toBeUndefined();
			});

			it('substitutes the credential id into all credential fields', () => {
				const workflow = JSON.parse(substitute(raw));
				const credIds = workflow.nodes
					.flatMap((n: { credentials?: Record<string, { id: string }> }) =>
						Object.values(n.credentials ?? {}).map((c) => c.id),
					)
					.filter(Boolean);
				expect(credIds.length).toBeGreaterThan(0);
				expect(credIds.every((id: string) => id.startsWith('test-'))).toBe(true);
			});
		});
	}
});
