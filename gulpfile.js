const { src, dest } = require('gulp');

// Copies node icons into dist so n8n can display them.
function buildIcons() {
	return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

exports['build:icons'] = buildIcons;
