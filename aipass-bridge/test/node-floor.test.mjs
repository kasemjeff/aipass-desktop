// The Node floor is one number in four places; when they drift, dev, CI
// and the packaged build each answer a different question. This test pins
// the agreement (engines, .nvmrc, sidecar, CI matrix, README badge) and
// proves the check itself catches drift when handed mismatched sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRepoNodeFloor, checkNodeFloor, NODE_FLOOR } from '../../scripts/check-node-floor.mjs';

test('the Node floor agrees everywhere: engines, .nvmrc, sidecar, CI, README', () => {
  const { floor, problems } = checkRepoNodeFloor();
  assert.equal(floor, 24);
  assert.equal(NODE_FLOOR, 24);
  assert.deepEqual(problems, [], problems.length ? `mismatches:\n- ${problems.join('\n- ')}` : '');
});

test('the floor check catches drift in each source', () => {
  const good = {
    pkgText: JSON.stringify({ engines: { node: '>=24' } }),
    nvmrcText: '24\n',
    sidecarMajor: 24,
    workflowText: 'node: [24]\nnode-version: 24\n',
    readmeText: 'node-%E2%89%A524 Node >= 24',
  };
  assert.deepEqual(checkNodeFloor(good).problems, []);
  assert.ok(checkNodeFloor({ ...good, pkgText: JSON.stringify({ engines: { node: '>=20' } }) }).problems.some(p => p.includes('engines')));
  assert.ok(checkNodeFloor({ ...good, nvmrcText: '20\n' }).problems.some(p => p.includes('.nvmrc')));
  assert.ok(checkNodeFloor({ ...good, sidecarMajor: 20 }).problems.some(p => p.includes('REQUIRED_NODE_MAJOR')));
  assert.ok(checkNodeFloor({ ...good, workflowText: 'node: [20, 22, 24]' }).problems.some(p => p.includes('test.yml')));
  assert.ok(checkNodeFloor({ ...good, workflowText: 'node: [24]\nnode-version: 20' }).problems.some(p => p.includes('node-version: 20')));
  assert.ok(checkNodeFloor({ ...good, readmeText: 'Node >= 20' }).problems.some(p => p.includes('README')));
});
