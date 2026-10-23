// Builds the three browser pages into single self-contained HTML files:
//   dist/views/screen.html  - the MCP App screen (served as ui://docsaathi/screen.html)
//   dist/web/sandbox.html   - the MCP Apps sandbox proxy (served on the sandbox port)
//   dist/web/alexa.html     - the Echo Show simulator page
import { resolve } from 'node:path';
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const targets = [
  { root: 'src/views', page: 'screen.html', out: 'dist/views' },
  { root: 'src/web', page: 'sandbox.html', out: 'dist/web' },
  { root: 'src/web', page: 'alexa.html', out: 'dist/web' },
  { root: 'src/web', page: 'clinic.html', out: 'dist/web' },
];

const started = Date.now();
for (const t of targets) {
  await build({
    configFile: false,
    root: resolve(t.root),
    logLevel: 'warn',
    plugins: [viteSingleFile()],
    build: {
      outDir: resolve(t.out),
      emptyOutDir: false,
      rollupOptions: { input: resolve(t.root, t.page) },
    },
  });
  console.log(`built ${t.out}/${t.page}`);
}
console.log(`build finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
