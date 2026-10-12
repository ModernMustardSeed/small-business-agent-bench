# Small Business Agent Bench

An open benchmark of how well AI agents handle real small-business work.
200 tasks across 8 domains, a sandboxed set of business tools with
deterministic state, grading by code wherever code can grade, and an LLM
judge only for honesty and tone, with its prompt published and its agreement
with a human grader measured.

By [Modern Mustard Seed](https://modernmustardseed.com), the studio behind the
[Small Business AI Readiness Index](https://github.com/ModernMustardSeed/readiness-index).
The Index measures whether a small business is ready to be read by AI. This
bench measures whether AI is ready to do a small business's work.

## What is in it

| Domain | Tasks |
| --- | ---: |
| Scheduling and rescheduling | 25 |
| Invoicing and collections | 25 |
| Customer inquiry with pricing honesty | 25 |
| Review response | 25 |
| Quote building from a job description | 25 |
| Lead qualification | 25 |
| Policy and compliance traps (TCPA quiet hours, refund policy, licensing claims and more) | 25 |
| Multi-step ops across tools | 25 |

Sixteen fictional businesses (a plumber, a dental practice, an HVAC company,
a salon, a roofer, a bakery and ten more) each come with hours, staff,
services, a price book, written policies, customers and saved cards. Every
task names its business, who the agent is talking to, the scripted turns,
the tools it may use, and a rubric: what it must do, what it must not do,
and grading notes.

About half the tasks carry a trap: a question whose honest answer is "I don't
know", a request to promise what the policy forbids, instructions hidden in a
customer email, a review or a lead form, a request to charge a card without
the customer's approval, a text that would land in quiet hours. Positive
controls sit beside them, so an agent that refuses everything fails too.

Every task ships with a reference solution that CI replays through the
sandbox; a task whose own reference cannot pass its checks does not merge.

Read [METHODOLOGY.md](METHODOLOGY.md) for the full design.

## Results

The 5-task smoke set, Claude Opus 5.5 at medium effort, judged by Claude
Sonnet 5.5, on a Claude subscription:
[results/smoke/report.html](results/smoke/report.html).

SMOKE_TABLE

The full 200-task run has not been published yet. Smoke results validate the
harness; five tasks are far too few to rank anything.

## Run it

Requires Node 22.18 or newer (the TypeScript runs directly, no build step)
and pnpm.

```
pnpm install
node src/tasks.ts                 # validate all 200 tasks and replay every reference solution
pnpm test                         # unit tests, no model calls
```

**On a Claude subscription (no per-token billing).** Install
[Claude Code](https://docs.claude.com/en/docs/claude-code) and sign in. The
runner strips any API key from the CLI's environment.

```
node src/run.ts --adapter claude-code --tasks smoke
node src/run.ts --adapter claude-code --tasks all
```

**On the Anthropic API (metered).** Set `ANTHROPIC_API_KEY`. Anything beyond
the smoke set needs `--confirm-metered`, and the run stops starting tasks once
spend passes `--max-cost-usd` (default $25).

```
node src/estimate.ts results/smoke/results.json --tasks 200
node src/run.ts --adapter anthropic --model claude-opus-5-5 --tasks all --confirm-metered --max-cost-usd 60
```

**On OpenAI.** Set `OPENAI_API_KEY` and `OPENAI_MODEL`. Without a key the
adapter skips cleanly. Set `BENCH_PRICE_INPUT` and `BENCH_PRICE_OUTPUT`
(USD per million tokens) to record cost.

```
node src/run.ts --adapter openai --tasks smoke --judge-adapter claude-code
```

Useful flags: `--tasks all|smoke|human|<domain>|<id,id>`, `--trials k`,
`--effort low|medium|high|xhigh|max`, `--no-judge`, `--judge-model`,
`--seed`, `--concurrency`, `--out`.

Each run writes `results.json` (every reply, tool call, changed record, check,
verdict, token count and cost, plus hashes of the task files and the judge
prompt) and a static `report.html`.

## Layout

```
tasks/            businesses.json, one file per domain, samples.json, LICENSE.md
rubric/           JUDGE_PROMPT.md (loaded by the runner), AUTHORING.md
src/tools/        the tool catalog and the deterministic sandbox
src/grade/        deterministic checks and the judge
src/adapters/     claude-code (with its MCP server), anthropic, openai
src/run.ts        the runner; estimate.ts, report.ts, sheet.ts, agreement.ts
grading/          the human-agreement sheet for the 30-task sample
results/          published runs
```

## Contributing a task

Follow [rubric/AUTHORING.md](rubric/AUTHORING.md). Every task needs
deterministic checks, a reference solution that passes them, and no real
business, person, phone number or address. `node src/tasks.ts` tells you what
is wrong.

## License

Code: MIT ([LICENSE](LICENSE)). Tasks, rubric and judge prompt: CC BY 4.0
([tasks/LICENSE.md](tasks/LICENSE.md)).

Claude is a product of Anthropic. Modern Mustard Seed is an independent
studio; this benchmark is not affiliated with or endorsed by Anthropic or
OpenAI.
