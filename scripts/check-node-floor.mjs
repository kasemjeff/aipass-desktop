#!/usr/bin/env node
// The Node floor is one number in four places. When they drift — engines
// says >=20 while .nvmrc and the sidecar say 24 — a dev machine, a CI lane
// and a packaged build each answer a different question about what Node
// the app needs, and nobody notices until a runtime breaks on the oldest
// supported version. This check makes the four places one place.
//
// Run standalone (`npm run node-floor:check`) or as part of the suite —
// `test/node-floor.test.mjs` imports checkNodeFloor() and asserts zero
// problems against the real repo files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REQUIRED_NODE_MAJOR } from '../desktop/sidecar/fetch-node.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_FLOOR = 24;

/**
 * Pure core: given the four sources as strings/values, return problems.
 * Injected so a test can prove the check actually catches drift.
 */
export function checkNodeFloor({ pkgText, nvmrcText, sidecarMajor, workflowText, readmeText }) {
  const problems = [];
  const expected = `>=${NODE_FLOOR}`;

  // 1. package.json engines
  let engines;
  try { engines = JSON.parse(pkgText).engines?.node; } catch { engines = undefined; }
  if (engines !== expected) {
    problems.push(`package.json: engines.node is ${JSON.stringify(engines)}, expected "${expected}"`);
  }

  // 2. .nvmrc
  if (String(nvmrcText).trim() !== String(NODE_FLOOR)) {
    problems.push(`.nvmrc: is ${JSON.stringify(String(nvmrcText).trim())}, expected "${NODE_FLOOR}"`);
  }

  // 3. sidecar pin
  if (sidecarMajor !== NODE_FLOOR) {
    problems.push(`desktop/sidecar/fetch-node.mjs: REQUIRED_NODE_MAJOR is ${sidecarMajor}, expected ${NODE_FLOOR}`);
  }

  // 4. CI test workflow: matrix must be exactly [24], smoke must be 24.
  //    A 20/22 in the matrix means a below-floor lane is still blessed.
  const matrixMatch = /node:\s*\[([^\]]+)\]/.exec(workflowText);
  if (!matrixMatch || matrixMatch[1].trim() !== String(NODE_FLOOR)) {
    problems.push(`.github/workflows/test.yml: test matrix node is ${matrixMatch ? `[${matrixMatch[1]}]` : 'missing'}, expected [${NODE_FLOOR}]`);
  }
  if (/node-version:\s*20\b/.test(workflowText)) {
    problems.push('.github/workflows/test.yml: a job still pins node-version: 20 (below floor)');
  }

  // 5. README badge must name the floor, not the old one.
  if (!readmeText.includes(`%E2%89%A5${NODE_FLOOR}`) || !readmeText.includes(`Node >= ${NODE_FLOOR}`)) {
    problems.push(`README.md: badge should read Node >= ${NODE_FLOOR}`);
  }

  return { floor: NODE_FLOOR, problems };
}

/** Read the real repo files and check them. */
export function checkRepoNodeFloor(root = ROOT) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  return checkNodeFloor({
    pkgText: read('package.json'),
    nvmrcText: read('.nvmrc'),
    sidecarMajor: REQUIRED_NODE_MAJOR,
    workflowText: read('.github/workflows/test.yml'),
    readmeText: read('README.md'),
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const { floor, problems } = checkRepoNodeFloor();
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error(`node-floor: ${problems.length} mismatch(es); floor is Node ${floor}`);
    process.exitCode = 1;
  } else {
    console.log(`node-floor: ok — engines, .nvmrc, sidecar and CI all agree on Node ${floor}`);
  }
}
