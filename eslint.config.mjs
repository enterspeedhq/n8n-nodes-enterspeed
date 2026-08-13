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
];
