import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { runInNewContext } from 'vm';
import { MAX_BULK_ENTITIES } from '../nodes/Enterspeed/actions/entity/shared';

// The example templates, and the test workflows that need more than n8n (workflows/fixtures).
const TEMPLATES_DIR = join(__dirname, '../workflows/templates');
const WORKFLOW_DIRS = [TEMPLATES_DIR, join(__dirname, '../workflows/fixtures')];
// Templates reference credentials via placeholders like
// __ENTERSPEED_CREDENTIAL_ID__ or __CONTENTFUL_CREDENTIAL_ID__. Discovering
// them by pattern (rather than an enumerated list) means a template can
// introduce a new credential type without any change needed here.
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+_CREDENTIAL_ID__/g;

function loadTemplates() {
	return WORKFLOW_DIRS.flatMap((dir) =>
		readdirSync(dir)
			.filter((f) => f.endsWith('.json'))
			.map((f) => ({ name: f, raw: readFileSync(join(dir, f), 'utf-8') })),
	);
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

describe('bulk-save-and-delete.json', () => {
	it('sends one origin id more than MAX_BULK_ENTITIES in its over-limit check', () => {
		const workflow = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'bulk-save-and-delete.json'), 'utf-8'));
		const node = workflow.nodes.find((n: { name: string }) => n.name === 'Build Over-Limit Origin IDs');
		const overLimit = Number(/const OVER_LIMIT = (\d+);/.exec(node.parameters.jsCode)?.[1]);
		expect(overLimit).toBe(MAX_BULK_ENTITIES + 1);
	});
});

describe('bulk-save-and-delete.json: the deleted check', () => {
	const workflow = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'bulk-save-and-delete.json'), 'utf-8'));
	const code = (name: string): string =>
		workflow.nodes.find((n: { name: string }) => n.name === name).parameters.jsCode;
	const expected = { originId: 'o-1', url: 'https://test.example/p-1', sku: 'SKU-1' };
	const notFound = { meta: { status: 404 }, route: null };
	const failedRequest = { error: 'Request failed with status code 503', description: 'Service Unavailable' };
	const liveRoute = { route: { sku: 'SKU-1' } };

	/** Runs a Code node's body the way n8n does: a function body with n8n's globals in scope. */
	const runNode = (jsCode: string, globals: Record<string, unknown>): unknown =>
		runInNewContext(`(() => {\n${jsCode}\n})()`, { ...globals, JSON });

	/** Runs `Check Entities Deleted` on one Get Content answer, as poll number `attempt`. */
	function checkDeleted(response: unknown, attempt: number) {
		const items = (values: unknown[]) => ({ all: () => values.map((json) => ({ json })) });
		const [item] = runNode(code('Check Entities Deleted'), {
			$runIndex: attempt - 1,
			$: () => items([expected]),
			$input: items([response]),
		}) as Array<{ json: Record<string, unknown> }>;
		return item.json;
	}

	/** Runs `Verify Entities Deleted` on what the check settled on. */
	function verifyDeleted(response: unknown) {
		const verdict = runNode(code('Verify Entities Deleted'), {
			$json: { ...expected, response, attempt: 18 },
		}) as { json: Record<string, unknown> };
		return verdict.json;
	}

	it('counts a route: null answer as gone', () => {
		expect(checkDeleted(notFound, 1).settled).toBe(true);
		expect(verifyDeleted(notFound).deleted).toBe(true);
	});

	it('keeps polling when Get Content failed, instead of counting the entity as gone', () => {
		expect(checkDeleted(failedRequest, 1).settled).toBe(false);
	});

	it('fails the check when Get Content still fails at the last poll', () => {
		expect(checkDeleted(failedRequest, 18).settled).toBe(true);
		const verdict = verifyDeleted(failedRequest);
		expect(verdict.deleted).toBe(false);
		expect(verdict.failure).toContain('Request failed with status code 503');
	});

	it('fails the check when the entity is still served', () => {
		expect(checkDeleted(liveRoute, 1).settled).toBe(false);
		expect(verifyDeleted(liveRoute).deleted).toBe(false);
	});
});
