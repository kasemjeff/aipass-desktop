Three small modules in `src/` each have one bug. Fix all three, then run
`node check.mjs` — it prints PASS only when all three are fixed. Don't
touch `check.mjs`.

- `src/avg.mjs`: average of the list — currently sums and divides by the
  list's length; the divisors are wrong. What is the correct answer for
  `average([2, 4, 6])`? 4.
- `src/max.mjs`: maximum of the list — currently returns the last element.
- `src/dup.mjs`: first duplicate — currently always returns `[0]`.
