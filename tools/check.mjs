import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Parse code only: this checker never starts the app or contacts an upstream.
const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
let failed = 0;
async function files(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${dir}/${entry.name}`);
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') result.push(...await files(file));
    } else if (entry.isFile()) result.push(file);
  }
  return result;
}
function syntax(label, source, type) {
  const result = spawnSync(process.execPath, ['--input-type=' + type, '--check'], {
    input: source, encoding: 'utf8', cwd: root, timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  checked++;
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAIL ${label}\n${result.stderr || result.error || 'parser failed'}`);
  }
}
for (const dir of ['js', 'server', 'tests', 'tools']) {
  for (const file of await files(dir)) {
    if (!/\.(?:m?js)$/.test(file)) continue;
    const type = file.startsWith('server/') || file === 'js/i18n.js' ? 'commonjs' : 'module';
    syntax(file, await readFile(path.join(root, file), 'utf8'), type);
  }
}
for (const file of ['index.html', 'login.html']) {
  const html = await readFile(path.join(root, file), 'utf8');
  let n = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    n++;
    if (/\bsrc\s*=/i.test(match[1])) continue;
    const declared = match[1].match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
    if (declared && !['module', 'text/javascript', 'application/javascript'].includes(declared)) continue;
    syntax(`${file}:inline-${n}`, match[2], declared === 'module' ? 'module' : 'commonjs');
  }
}
for (const file of ['package.json', 'manifest.json', 'server/package.json', 'server/package-lock.json']) {
  checked++;
  try { JSON.parse((await readFile(path.join(root, file), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { failed++; console.error(`FAIL ${file}: ${error.message}`); }
}
const shell = spawnSync('sh', ['-n', path.join(root, 'docker-entrypoint.sh')], {
  encoding: 'utf8', timeout: 15000,
});
checked++;
if (shell.error || shell.status !== 0) {
  failed++; console.error('FAIL shell syntax:', shell.stderr || shell.error);
}
console.log(`${checked} syntax/JSON checks; ${failed} failures.`);
console.log('Scope: offline JS, inline HTML scripts, JSON and shell syntax; NOT browser playback or Workers type checking.');
process.exitCode = failed ? 1 : 0;
