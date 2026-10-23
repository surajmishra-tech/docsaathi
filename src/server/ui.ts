// The MCP App screen (built by `npm run build` into dist/views/screen.html).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const SCREEN_URI = 'ui://docsaathi/screen.html';
const SCREEN_FILE = resolve(process.cwd(), 'dist', 'views', 'screen.html');

let cache: { mtimeMs: number; html: string } | undefined;

const MISSING = `<!doctype html><html><body style="font-family:system-ui;background:#0b1418;color:#eef6f8;display:grid;place-items:center;height:100vh;margin:0">
<p>DocSaathi screen is not built yet. Run <code>npm run build</code>.</p></body></html>`;

export function screenHtml(): string {
  if (!existsSync(SCREEN_FILE)) return MISSING;
  const { mtimeMs } = statSync(SCREEN_FILE);
  if (!cache || cache.mtimeMs !== mtimeMs) cache = { mtimeMs, html: readFileSync(SCREEN_FILE, 'utf8') };
  return cache.html;
}
