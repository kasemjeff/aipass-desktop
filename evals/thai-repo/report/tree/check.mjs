// Thai repository evaluation: the answer names the interest function and
// both functions the fixture ships. Fails on the untouched tree (no
// answer.txt at all).
import { existsSync, readFileSync } from 'node:fs';

const answer = existsSync('answer.txt') ? readFileSync('answer.txt', 'utf8') : '';
const problems = [];
if (!/\binterest\b/.test(answer)) problems.push('answer.txt must name the interest function (interest)');
if (!/\bvat\b/.test(answer)) problems.push('answer.txt must name the vat function (vat)');
if (!/\bcalc\.mjs\b/.test(answer)) problems.push('answer.txt must name the file shared/calc.mjs');

if (problems.length) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
