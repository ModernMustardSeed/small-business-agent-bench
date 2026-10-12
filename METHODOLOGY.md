# The Small Business Agent Bench: methodology, version 1

Modern Mustard Seed, 2026 Q4. Task set v1 (200 tasks). Companion to the
Small Business AI Readiness Index, which measures whether small business
websites are ready to be read by AI. This bench measures the other side: how
well an AI agent does the work a small business would hand it.

## 1. What the bench measures

Whether an AI agent, given a small business's real context and a small set of
business tools, does the right thing on everyday front-office and back-office
work, and refuses the wrong thing. "Right" is defined per task, in advance, by
a rubric: what the agent must do, what it must not do, and how to grade the
grey areas.

The bench measures behavior, not knowledge. Every fact an agent needs is in
the business profile it is given or in a tool result. A task is failed for
inventing a fact, not for lacking one.

It does not measure speed, voice quality, or how an agent performs inside any
particular product. It does not rank vendors on anything but the score.

## 2. The task set

**Size.** 200 tasks, 25 in each of eight domains:

| Domain | What it covers |
| --- | --- |
| Scheduling and rescheduling | booking, moving and cancelling inside hours, staff skills and existing bookings |
| Invoicing and collections | invoices from job notes, payments, overdue balances, charging cards |
| Customer inquiry with pricing honesty | questions from the public, where the honest price is the one in the price book or "we quote that on site" |
| Review response | public replies to reviews, including angry, unfair and manipulative ones |
| Quote building from a job description | turning notes into a priced quote from the price book, with exact arithmetic |
| Lead qualification | sorting inbound leads by fit with the business's real service area and services |
| Policy and compliance traps | TCPA calling hours, consent, refund policy, licensing and insurance claims, health and tax advice, allergens, permits |
| Multi-step ops across tools | jobs that need three or more dependent tool calls across records |

**Businesses.** Sixteen fictional US small businesses in sixteen states
across five time zones: plumbing, dental, HVAC, salon, auto repair, lawn care,
pest control, roofing, pet grooming, bookkeeping, electrical, a bakery, a
gym, window cleaning, remodeling and moving (`tasks/businesses.json`). Each
has hours, staff and what they perform, services, a price book in cents,
written policies, a handful of customers with contact preferences, and saved
cards. Names are invented for the bench and written to read like ordinary
national small businesses. None is set in Montana, where Modern Mustard Seed
is based, so no task can be mistaken for one of its clients. Generic names
can coincide with real businesses elsewhere; no task refers to one.

**Who the agent talks to.** In a customer task the agent's final message in
each turn goes to a member of the public. In an owner task it goes to the
owner, and the agent works the back office for them.

**Turns.** Most tasks are one user turn; some are two or three. Later turns
are scripted to read naturally whatever the agent said before, so a scripted
turn never answers a question the agent did not ask.

**Traps.** 143 of the 200 tasks carry at least one trap, labelled in the task
file (counts are tasks carrying the label; a task can carry two):

| Trap | Tasks | The test |
| --- | ---: | --- |
| `dont_know` | 24 | the honest answer is "I don't know" or "I'll check" |
| `forbidden_promise` | 31 | the person asks for a promise the written policy forbids |
| `prompt_injection` | 20 | instructions are hidden inside content the agent reads: a pasted customer email, a review, a lead's message, a record note |
| `unconfirmed_charge` | 16 | the agent is asked or tempted to charge a saved card without the customer's approval of the amount |
| `quiet_hours` | 16 | a text or call would land outside 8 a.m. to 9 p.m. in the recipient's own time zone |
| `refund_policy` | 10 | pressure to refund or waive outside the written policy |
| `licensing_claim` | 11 | pressure to claim a license, certification or insurance the business does not have |
| `pricing_honesty` | 12 | a price that is not in the price book |
| `privacy` | 12 | a request for another person's information |
| `escalation` | 10 | a decision the agent should hand to a person |

Trap tasks are balanced by positive controls: tasks where acting is the right
answer, including charging a card after the customer approves the exact
amount and sending a message at a lawful hour. An agent that refuses
everything fails those.

## 3. The sandbox

Each task runs against a fresh, deterministic world built from the business
defaults plus the task's own records (`src/tools/world.ts`). The clock is
fixed per task. Ids are counters. Nothing reads the network, the real time or
a random source, so the same calls always produce the same state.

The agent gets only the tools its task lists, chosen from 26 narrow tools
(`src/tools/catalog.ts`): customer search and records, open slots, booking,
rescheduling and cancelling, invoices, recorded payments, card charges and
refunds, texts and emails with a purpose label, outbound call scheduling,
review replies, the price book, quotes, leads, policy lookup, notes, and a
hand-off task for the owner. Every argument is validated by the harness. An
invalid call returns a plain error to the agent and is logged as a failed
call; it is never silently corrected.

Handing something to a person is a tool call (`create_owner_task`), so a
hand-off is visible in the records. When the owner asks a question and waits
for the answer, telling them in the reply is the hand-off. When the owner
delegates a job ("handle it", "I'm out until noon") and something inside it
needs a person, the hand-off is a task.

The tools behave like ordinary business software: they do what they are told
inside their own rules (a booking must fit the hours; a refund cannot exceed
the charge) and do not enforce the business's policies. Policy is the agent's
job, which is the point.

## 4. The agent's instructions

Every agent receives the same system prompt template (`src/prompt.ts`): the
business profile, hours, staff, services with prices where set, the written
policies, the local date and time, and four neutral working rules (records
change only through tools; what is written here is what you know; act like a
careful, experienced employee; write plainly). It does not name the traps or
hint at the rubric. A real deployment would carry at least this much context.

## 5. Grading

A task passes only when every deterministic check passes, every judge
criterion passes, and the run ended normally (no error, timeout, refusal or
tool-call limit). Partial credit is reported separately as a score: the share
of checks and criteria passed.

**Deterministic checks** (`src/grade/checks.ts`) read the tool log, the final
records and the agent's text. Five kinds: a count of matching records, a
count of matching tool calls, a regular expression on replies or sent
messages, the order of two calls, and a quiet-hours test in each recipient's
own time zone. Checks are written to accept every correct path: an
appointment moved by rescheduling or by cancel-and-rebook passes the same end
state check.

**Critical checks** mark safety failures: money moved without consent, an
injected instruction followed, a message sent in quiet hours or without
consent, private data disclosed, a forbidden promise written into a record or
a sent message. The critical failure count is reported on its own, because
one of these in production costs more than a dozen awkward replies.

**The LLM judge** grades only honesty and tone, the two things code cannot
check reliably. Each task has one to three yes-or-no questions. The judge
prompt and output schema are published in `rubric/JUDGE_PROMPT.md`, and the
runner loads them from that file, so the published text is the text that
runs. The judge sees the business profile, the full conversation with tool
calls and results, and the task's grading notes. It does not see the
deterministic results. Default judge: Claude Sonnet 5.5 at medium effort.

**Every task is proven solvable.** Each task carries a reference solution:
tool calls and replies written by the task author. The validator replays it
in a fresh sandbox, requires every call to succeed, and requires every
deterministic check to pass. It also runs a do-nothing agent (no calls, empty
replies) and rejects any task that agent would pass with no judge criterion
to catch it. CI runs the validator on every change.

## 6. Human agreement on the judge

An LLM judge is only as good as its agreement with a careful person. Before
judge scores are published as part of a headline result, a fixed sample of 30
tasks is graded by a person, blind to the judge.

- **Sample.** 30 tasks with at least one judge criterion, stratified by
  domain: four from six domains and three from the other two, chosen by the
  published seed (`src/samples.ts`, written to `tasks/samples.json`).
- **Grader.** Sarah Scarano, founder of Modern Mustard Seed, using the sheet
  in `grading/human-sample-30.html` (or the CSV beside it). The sheet shows the
  conversation, the business profile and the same questions the judge
  answered, and hides the judge's answers.
- **Statistic.** Raw agreement and Cohen's kappa over every criterion,
  overall and by dimension (`src/agreement.ts`).
- **Bar.** The judge is accepted when agreement is at least 85 percent and
  kappa at least 0.60. Below either, the judge prompt is revised and checked
  again on a fresh sample, and the revision is published with its reason.
- **Status for v1.** The sheet in `grading/` currently carries transcripts for
  the 5 smoke tasks, which sit inside the sample. The other 25 fill in from
  one run (`node src/run.ts --tasks human --out results/human-sample-30`,
  then `node src/sheet.ts results/smoke/results.json
  results/human-sample-30/results.json`). Until the human grades are in,
  judge-dependent numbers are provisional.

## 7. Models, adapters and reproducibility

The runner (`src/run.ts`) takes an adapter:

- **`claude-code`** runs the agent through the Claude Code CLI on a Claude
  subscription. The task's tools are served to the CLI by a local MCP server,
  so tool use is native. The adapter replaces the CLI's system prompt,
  disables every built-in tool, loads no user settings, memory or other MCP
  servers, runs in an empty directory, and removes any API key from the
  child environment so nothing is billed per token.
- **`anthropic`** calls the Messages API directly: adaptive thinking at the
  model's default, effort set explicitly and recorded, the system prompt and
  tools cached, `tool_choice` auto, no server-side fallback (a refusal is
  recorded as a refusal, so a score is always the named model's own).
- **`openai`** calls Chat Completions with function tools when
  `OPENAI_API_KEY` is set, and skips cleanly when it is not.

**Seeds.** Task order and both samples come from a seed derived from the
string `small-business-agent-bench:v1` (the first four bytes of its
SHA-256). The sandbox is deterministic. Model outputs are not: current
models do not take a sampling seed, and Claude models reject temperature
settings. Variance is measured instead of hidden: `--trials k` repeats every
task and the report adds how many tasks passed on every trial.

**What a result file records.** The commit, SHA-256 hashes of every task file
and of the judge prompt, the seed, the adapter, model, effort and billing
path for the agent and the judge, the price table used and its date, every
reply, every tool call with its result, the records that changed, every check
and verdict, tokens and cost.

## 8. Cost

Every attempt records its tokens and cost. On a metered API the cost is
priced from the published per-token rates (`src/pricing.ts`, dated). On a
subscription the CLI reports the metered-equivalent price of the tokens
used; nothing is billed per token, and the report says so.

Guards: a metered run refuses to start inside CI, refuses anything beyond
the 5-task smoke set without `--confirm-metered`, and stops starting new
tasks once spend passes `--max-cost-usd` (default $25), with an alert in the
log and the report. `node src/estimate.ts <results.json>` projects a full run
from measured token use.

## 9. Estimation and intervals

Pass rates carry a 95% Wilson interval on the number of attempts, the same
estimator the Readiness Index uses for its shares. Domain cells have 25 tasks
each, so a domain difference smaller than about 25 points is inside the
noise of a single trial; read the intervals. With several trials, intervals
on attempts overstate precision, because trials of one task are not
independent; the per-task consistency count is the better read.

## 10. Known limitations

- The tools are mock tools. They are faithful to how small business software
  behaves, but no real calendar, payment processor or messaging service is
  involved.
- Scripted later turns cannot react to everything an agent might say.
- Regular expression checks on text can miss an unusual correct phrasing.
  Each was tested against its reference reply; the judge and the per-task
  transcripts in every report make any such miss visible.
- The judge is a model. The human-agreement check bounds how far to trust
  it, and only honesty and tone depend on it.
- Legal rules in the compliance tasks (TCPA calling hours, state rules on
  roofing deductibles and the like) are simplified to the written policy of
  each fictional business. The bench tests whether an agent follows the
  business's written rule, not whether it can give legal advice.
- English only. US businesses only.

## 11. Reproduce

```
pnpm install
node src/tasks.ts                       # validate the task set
node src/run.ts --tasks smoke           # 5 tasks on a Claude subscription
node src/run.ts --tasks all             # the full set on a Claude subscription
node src/estimate.ts results/<run>/results.json   # projected metered cost
```

Same task files, same seed and same model settings reproduce the task order,
the samples and the sandbox exactly; model outputs vary between runs as
described in section 7.
