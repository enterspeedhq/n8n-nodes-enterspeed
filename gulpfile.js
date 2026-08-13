const { src, dest } = require('gulp');

// `n8n-node build`/`n8n-node dev` copy node icons into dist/nodes themselves,
// but don't know about the Enterspeed API credential reusing that same icon
// (`file:enterspeed.svg`, resolved relative to
// dist/credentials/EnterspeedApi.credentials.js). Chained after those
// commands in package.json to fill that one gap.
function copyCredentialIcons() {
	return src('nodes/Enterspeed/enterspeed.svg').pipe(dest('dist/credentials'));
}

exports['copy-credential-icons'] = copyCredentialIcons;
