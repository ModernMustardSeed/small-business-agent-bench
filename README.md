# Small Business Agent Bench

An open benchmark of how well AI agents handle real small-business work.
200 tasks across 8 domains, a sandboxed set of business tools with
deterministic state, grading by code wherever code can grade, and an LLM
judge only for honesty and tone, with its prompt published and its agreement
with a human grader measured.

By [Modern Mustard Seed](https://modernmustardseed.com), the studio behind the
Small Business AI Readiness Index.
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
| Policy and compliance traps (TCPA calling window, refund policy, licensing claims and more) | 25 |
| Multi-step ops across tools | 25 |

Sixteen fictional businesses (a plumber, a dental practice, an HVAC company,
a salon, a roofer, a bakery and ten more) each come with opening times, staff,
services, a price book, written policies, customers and saved cards. Every
task names its business, who the agent is talking to, the scripted turns,
the tools it may use, and a rubric: what it must do, what it must not do,
and grading notes.

About half the tasks carry a trap: a question whose honest answer is "I don't
know", a request to promise what the policy forbids, instructions hidden in a
customer email, a review or a lead form, a request to charge a card without
the customer's approval, a text that would land outside the calling window. Positive
controls sit beside them, so an agent that refuses everything fails too.

Every task ships with a reference solution that CI replays through the
sandbox; a task whose own reference cannot pass its checks does not merge.

Read [METHODOLOGY.md](METHODOLOGY.md) for the full design.

## Results

None published yet. The October 12, 2026 smoke run and the 30-task human
sample were withdrawn: the Claude Code CLI attached the operator's own account
context (email address, working directory, real date) to every request, even
with a custom system prompt, so those transcripts were contaminated. The
`claude-code` adapter now runs each task in a clean room authenticated only by
a `claude setup-token` token, and the runner refuses to write any run whose
transcripts contain an operator identifier (`src/leak.ts`, also enforced in CI).
Results will be published after an isolated re-run.

**Full-run cost.** The withdrawn smoke run used about 10,000 agent tokens per
task. At Anthropic list prices as of 2026-10-06 that projects to roughly $8 for
all 200 tasks with Claude Opus 5.5 as the agent and Claude Sonnet 5.5 as the
judge (about $10 with a 30 percent margin). `node src/estimate.ts
<results.json> --tasks 200` re-projects from any clean run. On a Claude
subscription through the `claude-code` adapter, nothing is billed per token.

## Run it

Requires Node 22.18 or newer (the TypeScript runs directly, no build step)
and pnpm.

```
pnpm install
node src/tasks.ts                 # validate all 200 tasks and replay every reference solution
pnpm test                         # unit tests, no model calls
```

**On a Claude subscription (no per-token billing).** Install
[Claude Code](https://docs.claude.com/en/docs/claude-code) and create a
long-lived token once with `claude setup-token`. Save the token in a file
outside every repository: by default `~/.bench/oauth-token.txt`
(`%USERPROFILE%\.bench\oauth-token.txt` on Windows), or any path named in
`BENCH_OAUTH_TOKEN_FILE`. Do not set it as a user-level environment variable:
a global `CLAUDE_CODE_OAUTH_TOKEN` takes over auth in every interactive Claude
Code session on the machine. The runner reads the file and injects the token
only into each task's clean room: an empty config directory, an allowlisted
environment with no account, API key or username, and a working directory
outside your user profile. The adapter refuses a token file inside a git work
tree, refuses to use a logged-in profile (it attaches your account details to
every request), and the leak check fails any run whose transcript contains the
token. In CI the token comes from the `CLAUDE_CODE_OAUTH_TOKEN` repository
secret instead.

```
node src/run.ts --adapter claude-code --tasks smoke
node src/run.ts --adapter claude-code --tasks all
```

**On the Anthropic API (metered).** Set `ANTHROPIC_API_KEY`. Anything beyond
the smoke set needs `--confirm-metered`, and the run stops starting tasks once
spend passes `--max-cost-usd` (default $25).

```
node src/estimate.ts results/<smoke run>/results.json --tasks 200
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
