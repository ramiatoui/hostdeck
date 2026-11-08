// Bundles the renderer (UI) code and its CSS dependencies into dist/.
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const root = path.join(__dirname, '..');

const options = {
  entryPoints: {
    renderer: path.join(root, 'src/renderer/app.js'),
    vendor: path.join(root, 'src/renderer/vendor.css'),
  },
  outdir: path.join(root, 'dist'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('Watching renderer for changes...');
  } else {
    await esbuild.build(options);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
