import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const guard = fileURLToPath(new URL('../tools/ai_guard.py', import.meta.url));
function run(cwd, command, args, check = true) {
  const childEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  // A nested node --test must not inherit the parent's internal runner context:
  // otherwise Node skips the files and exits 0 without executing the fixture.
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 20000, env: childEnv });
  if (check) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function put(dir, name, text) {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
}
// Integration seam: guard stages, a trusted checkout-index materializes, tests
// then run on candidate bytes. No GitHub API, model API, app service or credentials.
test('fresh verification really executes candidate tests, not just baseline code', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'solara-pipeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const fresh = path.join(dir, 'verify');
  const out = path.join(dir, 'candidate');
  mkdirSync(source);
  put(source, 'package.json', '{"private":true,"type":"module"}');
  put(source, '.gitignore', '.ai-work/\n');
  put(source, 'js/fixture.js', 'export const stable = true;\nexport const candidate = "old";\n');
  put(source, 'tests/baseline.test.mjs', 'import {test} from "node:test"; import assert from "node:assert/strict"; import {stable} from "../js/fixture.js"; test("baseline",()=>assert.equal(stable,true));\n');
  run(source, 'git', ['init', '-q']);
  run(source, 'git', ['add', '.']);
  run(source, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline fixture']);
  const base = run(source, 'git', ['rev-parse', 'HEAD']).stdout.trim();
  run(dir, 'git', ['clone', '-q', '--no-hardlinks', source, fresh]);
  put(source, 'js/fixture.js', 'export const stable = true;\nexport const candidate = "new";\n');
  put(source, 'tests/new-behavior.test.mjs', 'import {test} from "node:test"; import assert from "node:assert/strict"; import {candidate} from "../js/fixture.js"; test("candidate bytes",()=>assert.equal(candidate,"new"));\n');
  run(source, 'python3', [guard, 'export', '--base', base, '--out', out]);
  run(fresh, 'python3', [guard, 'apply', '--base', base, '--patch', path.join(out, 'candidate.patch')]);
  run(fresh, 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'checkout-index', '--all', '--force']);
  assert.match(readFileSync(path.join(fresh, 'js/fixture.js'), 'utf8'), /candidate = "new"/);
  run(fresh, process.execPath, ['--test', 'tests/baseline.test.mjs', 'tests/new-behavior.test.mjs']);
  // Break ONLY the materialized candidate after a valid patch. A verifier that
  // accidentally reran BASE tests would pass; this exact run must now fail.
  put(fresh, 'js/fixture.js', 'export const stable = true;\nexport const candidate = "old";\n');
  const broken = run(fresh, process.execPath, ['--test', 'tests/baseline.test.mjs', 'tests/new-behavior.test.mjs'], false);
  assert.notEqual(broken.status, 0, `new candidate regression must be observable\n${broken.stdout}\n${broken.stderr}`);
});
