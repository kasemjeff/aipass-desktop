// Thai repository evaluation: run the repo's own interest() over the
// fixture's inputs and require answer.txt to hold exactly that number.
// Fails on the untouched tree (no answer.txt at all).
import { existsSync, readFileSync } from 'node:fs';
import { interest } from './shared/calc.mjs';

const expected = interest(10000, 0.03, 2); // 600
const answer = existsSync('answer.txt') ? readFileSync('answer.txt', 'utf8').trim() : '';
if (answer !== String(expected)) {
  console.error(`FAIL: answer.txt is "${answer}", want "${expected}" (interest(10000, 0.03, 2))`);
  process.exit(1);
}
console.log('PASS');
