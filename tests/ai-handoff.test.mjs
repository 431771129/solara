import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const helper = fileURLToPath(new URL('../tools/ai_handoff.py', import.meta.url));
const fixture = (patch = '') => ({ patch_base64: Buffer.from(patch).toString('base64'), summary: 'fixture only', evidence: ['offline fixture'], no_change_reason: '' });
function run(t, raw) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'solara-handoff-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const out = path.join(temp, 'decoded');
  const outputs = path.join(temp, 'outputs');
  const result = spawnSync('python3', [helper, 'decode', '--out', out], {
    encoding: 'utf8', env: { ...process.env, AI_RESULT: typeof raw === 'string' ? raw : JSON.stringify(raw), GITHUB_OUTPUT: outputs },
    timeout: 45000,
  });
  assert.ifError(result.error); // A timeout is NOT a successful fail-closed verdict.
  return { ...result, out, outputs };
}

test('empty structured candidate is an honest no-change outcome', (t) => {
  const result = run(t, { ...fixture(), no_change_reason: 'No reproducible in-scope failure' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(path.join(result.out, 'candidate.patch')).length, 0);
  assert.equal(readFileSync(result.outputs, 'utf8'), 'has_patch=false\n');
});
test('decode preserves patch bytes without executing shell-shaped text', (t) => {
  const patch = 'data, not a command: $(false)\n';
  const result = run(t, fixture(patch));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(path.join(result.out, 'candidate.patch'), 'utf8'), patch);
  assert.equal(readFileSync(result.outputs, 'utf8'), 'has_patch=true\n');
});
test('malformed base64 and wrong field types fail closed', (t) => {
  for (const value of [
    { ...fixture(), patch_base64: '%%%not base64%%%' },
    { ...fixture(), evidence: 'not a list' },
    { ...fixture(), summary: ['wrong type'] },
    { ...fixture(), extra: 'unexpected' },
    { ...fixture(), patch_base64: 42 },
    'not JSON',
  ]) {
    const result = run(t, value);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.out), false);
  }
});
test('oversized bytes, summary and evidence fail before publication', (t) => {
  for (const value of [
    fixture('x'.repeat(65537)),
    { ...fixture(), summary: 'x'.repeat(2001) },
    { ...fixture(), evidence: Array(17).fill('too many') },
    { ...fixture(), evidence: ['x'.repeat(2001)] },
  ]) {
    const result = run(t, value);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.out), false);
  }
});
