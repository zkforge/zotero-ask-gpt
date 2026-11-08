// Runs test/render.test.html in headless Chrome and reports the results.
// Usage: CHROME=/path/to/chrome-headless-shell node test/browser-test.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const chrome = process.env.CHROME;
if (!chrome) {
  console.error('Set CHROME to a Chrome / chrome-headless-shell executable.');
  process.exit(2);
}
const page = pathToFileURL(fileURLToPath(new URL('render.test.html', import.meta.url))).href;
const dom = execFileSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
  '--virtual-time-budget=5000', '--dump-dom', page], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
const raw = /<pre id="results">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
if (!raw) {
  console.error('No results found; the test page did not finish.');
  process.exit(1);
}
const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const results = JSON.parse(unescape(raw));
for (const { name, ok, error } of results) console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `\n    ${error}`}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
