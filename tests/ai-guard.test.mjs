import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'ai_guard.py');
const PYTHON = process.env.PYTHON || 'python3';
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

function command(cwd, file, args, options = {}) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', env, ...options });
  if (result.error) throw result.error;
  return result;
}
function git(repo, ...args) {
  const result = command(repo, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function writeFile(repo, name, body) {
  const target = path.join(repo, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}
function snapshotTree(root) {
  const entries = [];
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      entries.push([relative, stat.mode & 0o777, stat.isFile() ? readFileSync(full).toString('base64') : stat.isSymbolicLink() ? `link:${readFileSync(full, 'utf8')}` : 'directory']);
      if (stat.isDirectory()) walk(full, relative);
    }
  }
  walk(root);
  return entries;
}
function repo(t, files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solara-ai-guard-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Guard fixture');
  git(dir, 'config', 'user.email', 'guard@example.invalid');
  for (const [name, body] of Object.entries(files)) writeFile(dir, name, body);
  git(dir, 'add', '--', '.');
  git(dir, 'commit', '-qm', 'independent fixture');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
function cloneClean(t, source, base) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solara-ai-guard-clean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = command(path.dirname(dir), 'git', ['clone', '-q', '--no-hardlinks', source, dir]);
  assert.equal(result.status, 0, result.stderr);
  git(dir, 'checkout', '-q', '--detach', base);
  return dir;
}
function cli(cwd, ...args) {
  return command(cwd, PYTHON, [CLI, ...args]);
}
function exportCandidate(cwd, base, out) {
  return cli(cwd, 'export', '--base', base, '--out', out);
}

// Public CLI seam: export a worktree diff, preserve the real index, and stage
// only the independently declared candidate when a trusted checkout applies it.
test('allowed JavaScript and a new test round-trip without changing worktree or export index', (t) => {
  const r = repo(t, { 'js/app.js': 'export const label = "old";\n' });
  const clean = cloneClean(t, r.dir, r.base);
  writeFile(r.dir, 'js/app.js', 'export const label = "new";\n');
  writeFile(r.dir, 'tests/guard-smoke.test.mjs', 'import test from "node:test";\ntest("independent fixture", () => {});\n');
  git(r.dir, 'add', '--', 'js/app.js');
  const realIndex = path.join(r.dir, git(r.dir, 'rev-parse', '--git-path', 'index'));
  const indexBefore = readFileSync(realIndex);
  const objectsDir = path.join(r.dir, git(r.dir, 'rev-parse', '--git-path', 'objects'));
  const objectsBefore = snapshotTree(objectsDir);
  const out = path.join(r.dir, '.ai-work', 'candidate');
  t.after(() => rmSync(path.join(r.dir, '.ai-work'), { recursive: true, force: true }));

  const exported = exportCandidate(r.dir, r.base, out);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /2 files/);
  assert.deepEqual(readFileSync(realIndex), indexBefore, 'export must leave the original index byte-for-byte intact');
  assert.deepEqual(snapshotTree(objectsDir), objectsBefore, 'export must not write into the original object store');
  const patch = readFileSync(path.join(out, 'candidate.patch'), 'utf8');
  assert.match(patch, /js\/app\.js/);
  assert.match(patch, /tests\/guard-smoke\.test\.mjs/);
  const metadata = JSON.parse(readFileSync(path.join(out, 'metadata.json'), 'utf8'));
  assert.equal(metadata.base, r.base);
  assert.equal(metadata.files, 2);

  const applied = cli(clean, 'apply', '--base', r.base, '--patch', path.join(out, 'candidate.patch'));
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(readFileSync(path.join(clean, 'js/app.js'), 'utf8'), 'export const label = "old";\n', 'apply changes index, never worktree');
  assert.equal(git(clean, 'show', ':js/app.js'), 'export const label = "new";');
  assert.equal(git(clean, 'show', ':tests/guard-smoke.test.mjs'), 'import test from "node:test";\ntest("independent fixture", () => {});');
  assert.equal(git(clean, 'status', '--porcelain').split('\n').length, 2);
});

for (const [label, mutate, signal] of [
  ['workflow edits', r => writeFile(r.dir, '.github/workflows/ci.yml', 'name: changed\n'), /allowlisted/],
  ['existing test edits', r => writeFile(r.dir, 'tests/baseline.test.mjs', 'throw new Error("weakened");\n'), /existing tests/],
  ['storage edits', r => writeFile(r.dir, 'js/core/storage.js', 'export const protectedValue = 2;\n'), /allowlisted/],
  ['deletions', r => rmSync(path.join(r.dir, 'js/app.js')), /unsupported/],
  ['renames', r => renameSync(path.join(r.dir, 'js/app.js'), path.join(r.dir, 'js/renamed.js')), /unsupported/],
  ['executable bits', r => chmodSync(path.join(r.dir, 'js/app.js'), 0o755), /executable|mode/],
  ['symlink additions', r => symlinkSync('app.js', path.join(r.dir, 'js/link.js')), /symlink|mode/],
  ['binary content', r => writeFile(r.dir, 'js/app.js', Buffer.from([1, 0, 2, 3])), /binary/],
  ['unsafe path names', r => writeFile(r.dir, 'js/space name.js', 'export const x=1;\n'), /unsafe path/],
  ['more than eight files', r => { for (let i=0;i<9;i++) writeFile(r.dir, `js/new-${i}.js`, 'export const x=1;\n'); }, /file cap/],
  ['more than 300 changed lines', r => writeFile(r.dir, 'js/app.js', Array.from({length:301},(_,i)=>`// new ${i}\n`).join('')), /line cap/],
  ['more than 64 KiB patch', r => writeFile(r.dir, 'js/app.js', '// '+ 'x'.repeat(66000)+'\n'), /patch-size cap/],
]) {
  test(`export rejects ${label} without changing the original index`, (t) => {
    const r = repo(t, {
      '.gitignore': '.ai-work/\n',
      'js/app.js': 'export const baseline = true;\n',
      'js/core/storage.js': 'export const protectedValue = 1;\n',
      'tests/baseline.test.mjs': '// protected baseline test\n',
    });
    const original = readFileSync(path.join(r.dir, '.git', 'index'));
    mutate(r);
    const result = exportCandidate(r.dir, r.base, path.join(r.dir, '.ai-work', 'candidate'));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, signal);
    assert.deepEqual(readFileSync(path.join(r.dir,'.git','index')), original);
  });
}

test('empty export returns 3 and exact base mismatches fail closed', (t) => {
  const r = repo(t, { 'js/app.js': 'export const value = 1;\n' });
  const out = path.join(r.dir, '.ai-work', 'candidate');
  const empty = exportCandidate(r.dir, r.base, out);
  assert.equal(empty.status, 3, empty.stdout + empty.stderr);
  assert.equal(existsSync(path.join(out, 'candidate.patch')), false);
  writeFile(r.dir, 'js/app.js', 'export const value = 2;\n');
  for (const bad of ['HEAD', '0'.repeat(40)]) {
    assert.equal(exportCandidate(r.dir, bad, out).status, 2);
  }
});

test('clean applier independently rejects a protected patch from a generic git diff', (t) => {
  const r = repo(t, { '.gitignore': '.ai-work/\n', 'server/private.js': 'module.exports = 1;\n' });
  const clean = cloneClean(t, r.dir, r.base);
  writeFile(r.dir, 'server/private.js', 'module.exports = 2;\n');
  const patch = command(r.dir, 'git', ['diff','--no-ext-diff','--no-textconv']);
  assert.equal(patch.status, 0);
  writeFile(clean, '.ai-work/protected.patch', patch.stdout);
  const original = readFileSync(path.join(clean, '.git', 'index'));
  const result = cli(clean, 'apply', '--base', r.base, '--patch', path.join(clean,'.ai-work/protected.patch'));
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /allowlisted/);
  assert.deepEqual(readFileSync(path.join(clean,'.git','index')), original);
  assert.equal(readFileSync(path.join(clean,'server/private.js'),'utf8'), 'module.exports = 1;\n');
});

test('applier rejects a symlink patch rather than resolving it first', (t) => {
  const r = repo(t, { 'js/app.js': 'export const value = 1;\n' });
  const clean = cloneClean(t, r.dir, r.base);
  writeFile(r.dir, 'js/app.js', 'export const value = 2;\n');
  const out = path.join(r.dir, '.ai-work','candidate');
  assert.equal(exportCandidate(r.dir,r.base,out).status,0);
  const link = path.join(os.tmpdir(),`solara-patch-link-${process.pid}-${Date.now()}`);
  symlinkSync(path.join(out,'candidate.patch'),link);
  t.after(()=>rmSync(link,{force:true}));
  const result = cli(clean,'apply','--base',r.base,'--patch',link);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/regular file|symlink/);
});
