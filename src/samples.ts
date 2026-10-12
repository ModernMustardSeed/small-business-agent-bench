// Draws the two fixed samples from the task set with the published seed and
// writes tasks/samples.json:
// - human_agreement: 30 tasks with at least one judge criterion, stratified by
//   domain (4 from six domains, 3 from the other two, which two decided by the
//   seed), for the human-agreement check on the judge.
// - smoke: 5 tasks from inside that sample, chosen to cover the four hard
//   traps (unconfirmed charge, prompt injection, "I don't know", forbidden
//   promise or quiet hours) plus one task with no trap.
//
//   node src/samples.ts

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMAINS, type Task } from './types.ts';
import { loadTasks, TASK_DIR } from './tasks.ts';
import { seedFromString, seededShuffle } from './seed.ts';

export const SEED_STRING = 'small-business-agent-bench:v1';

export function drawSamples(tasks: Task[], seedString = SEED_STRING) {
  const seed = seedFromString(seedString);
  const threeFrom = new Set(seededShuffle([...DOMAINS], seed).slice(0, 2));
  const human: Task[] = [];
  DOMAINS.forEach((d, i) => {
    const pool = seededShuffle(
      tasks.filter((t) => t.domain === d && t.judge.length > 0),
      seed + 1 + i,
    );
    human.push(...pool.slice(0, threeFrom.has(d) ? 3 : 4));
  });
  const want: Array<(t: Task) => boolean> = [
    (t) => t.traps.includes('unconfirmed_charge'),
    (t) => t.traps.includes('prompt_injection'),
    (t) => t.traps.includes('dont_know'),
    (t) => t.traps.includes('forbidden_promise') || t.traps.includes('quiet_hours'),
    (t) => t.traps.length === 0,
  ];
  const smoke: Task[] = [];
  const order = seededShuffle(human, seed + 99);
  for (const fits of want) {
    const pick = order.find((t) => fits(t) && !smoke.includes(t) && !smoke.some((s) => s.domain === t.domain));
    const fallback = order.find((t) => fits(t) && !smoke.includes(t));
    const chosen = pick ?? fallback;
    if (chosen) smoke.push(chosen);
  }
  return {
    seed_string: seedString,
    seed,
    smoke: smoke.map((t) => t.id).sort(),
    human_agreement: human.map((t) => t.id).sort(),
  };
}

if (process.argv[1]?.endsWith('samples.ts')) {
  const s = drawSamples(loadTasks());
  writeFileSync(resolve(TASK_DIR, 'samples.json'), JSON.stringify(s, null, 2) + '\n');
  console.log(`smoke ${s.smoke.length}: ${s.smoke.join(', ')}`);
  console.log(`human_agreement ${s.human_agreement.length}`);
}
