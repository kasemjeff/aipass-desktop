# Thai Repository Evaluation (`evals/thai-repo`)

A small Thai-language project fixture (`README.md` + `shared/calc.mjs`)
with two tasks: read the repo and name what it ships, and run the repo's
own code over fixture inputs. This is the repository-evaluation lane —
`evals/thai/` measures Thai-language authoring on synthetic tasks; this
set measures repo understanding against Thai content, with both
directions scored by `check.mjs` on the applied tree (no LLM judge).

Select it with `--thai-repo`, or by id (`report`, `budget`). `task.json`
carries `lang: th` and `pair: thai-repo` like the Thai set. Everything
here is synthetic; nothing is copied from a public dataset.
