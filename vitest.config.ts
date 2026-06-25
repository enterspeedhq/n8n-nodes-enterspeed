import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		clearMocks: true,
		coverage: {
			provider: 'v8',
			include: ['nodes/**', 'credentials/**'],
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 70,
			},
		},
	},
});
