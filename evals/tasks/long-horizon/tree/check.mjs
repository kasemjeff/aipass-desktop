// Pass only when all three bugs are fixed (the long-horizon task: each fix
// is one file, and none alone earns a PASS). Fails on the untouched tree.
import { average } from './src/avg.mjs';
import { maximum } from './src/max.mjs';
import { firstDuplicate } from './src/dup.mjs';

const problems = [];
if (average([2, 4, 6]) !== 4) problems.push(`average([2,4,6]) = ${average([2, 4, 6])}, want 4`);
if (maximum([3, 1, 7, 2]) !== 7) problems.push(`maximum([3,1,7,2]) = ${maximum([3, 1, 7, 2])}, want 7`);
if (firstDuplicate([3, 1, 2, 1]) !== 1) problems.push(`firstDuplicate([3,1,2,1]) = ${firstDuplicate([3, 1, 2, 1])}, want 1`);

if (problems.length) {
  console.error('FAIL: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS');
