// The workflows are the CI contract, and they died quietly twice:
// package-lock.json drifted from package.json (every `npm ci` lane failed
// at install on all three platforms), and two scripts the workflows call
// — `dco` and `node-floor:check` — never existed in package.json, so the
// DCO lane failed with "Missing script" on every pull request. Neither is
// caught by the suite locally because locally node_modules already exists.
// These tests pin the wiring so the next drift fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('every npm script the workflows call exists in package.json', () => {
  const pkg = readJson('package.json');
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const called = new Set();
  for (const file of fs.readdirSync(wfDir)) {
    if (!file.endsWith('.yml')) continue;
    const text = fs.readFileSync(path.join(wfDir, file), 'utf8');
    for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) called.add(m[1]);
  }
  assert.ok(called.size > 0, 'the workflows call npm scripts');
  const missing = [...called].filter((name) => !(name in (pkg.scripts ?? {})));
  assert.deepEqual(missing, [], `workflows call scripts package.json does not define: ${missing.join(', ')}`);
});

test('package-lock.json root dependencies match package.json', () => {
  // `npm ci` refuses to install when the lock's root specifiers drift from
  // package.json — the exact failure that killed every CI lane at install.
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const lockRoot = lock.packages?.[''] ?? {};
  assert.deepEqual(lockRoot.devDependencies ?? {}, pkg.devDependencies ?? {},
    'lock root devDependencies do not match package.json — run npm install and commit the lock');
  assert.deepEqual(lockRoot.dependencies ?? {}, pkg.dependencies ?? {},
    'lock root dependencies do not match package.json — run npm install and commit the lock');
});
