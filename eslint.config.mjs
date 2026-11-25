import { config } from '@n8n/node-cli/eslint';

export default [
	...config,
	{
		// tests/ never ships (see package.json "files") — the cloud-compat
		// import/global restrictions exist for shipped node code, not for
		// Node-side test tooling that legitimately reads fixture files.
		files: ['tests/**/*.ts'],
		rules: {
			'@n8n/community-nodes/no-restricted-imports': 'off',
			'@n8n/community-nodes/no-restricted-globals': 'off',
		},
	},
	{
		// This rule's fix suggestion (`usableAsTool: true`) is wrong for a
		// trigger node: the real n8n verification scanner forbids `true` here,
		// and the type has no `false` — see ARCHITECTURE.md "Known lint
		// inconsistency". Omitting the property is correct; the rule doesn't
		// know that, so it's suppressed for this file only.
        // https://github.com/n8n-io/n8n/blob/master/packages/@n8n/eslint-plugin-community-nodes/docs/rules/node-usable-as-tool.md
		files: ['nodes/Enterspeed/EnterspeedTrigger.node.ts'],
		rules: {
			'@n8n/community-nodes/node-usable-as-tool': 'off',
		},
	},
];
