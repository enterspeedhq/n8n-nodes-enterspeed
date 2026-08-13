const { src, dest, series } = require('gulp');

// Copies node icons into dist so n8n can display them.
function buildNodeIcons() {
	return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

// The Enterspeed API credential reuses the node icon (`file:enterspeed.svg`
// resolved relative to dist/credentials/EnterspeedApi.credentials.js).
function buildCredentialIcons() {
	return src('nodes/Enterspeed/enterspeed.svg').pipe(dest('dist/credentials'));
}

exports['build:icons'] = series(buildNodeIcons, buildCredentialIcons);
