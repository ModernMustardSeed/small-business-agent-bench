// Leak check. Every task is fictional: every email address in a task uses a
// reserved example domain and no task names a real home directory. So any of
// these in a transcript came from the machine or account running the bench,
// not from the task, and the run is contaminated:
//   1. an email address that is not on an .example or example.com domain;
//   2. a home directory path (C:\Users\<name>, /Users/<name>, /home/<name>);
//   3. any operator identifier supplied at run time in BENCH_OPERATOR_IDENTIFIERS
//      (comma separated: email, name, username), plus this machine's own
//      username and home directory.
// Identifiers are read from the environment and the OS at run time and are
// never written to the repository.
//
//   node src/leak.ts [path ...]        scan files or directories (default: results grading)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import os from 'node:os';
import { readBenchToken } from './token.ts';

export interface LeakHit {
  where: string;
  kind: 'email' | 'home_path' | 'identifier';
  sample: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOME_PATH = /(?:[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+|\/Users\/|\/home\/)([A-Za-z0-9._ -]{2,40})/gi;
// Accounts that belong to generic CI or container images, not to a person.
const GENERIC_HOMES = new Set(['runner', 'runneradmin', 'public', 'default', 'node', 'root', 'user']);

function decode(text: string): string {
  // Result files escape some characters (see safeJson in report.ts); decode before scanning.
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\\\\/g, '\\');
}

export function operatorIdentifiers(): string[] {
  const ids = new Set<string>();
  for (const v of (process.env.BENCH_OPERATOR_IDENTIFIERS ?? '').split(',')) if (v.trim().length >= 3) ids.add(v.trim().toLowerCase());
  try {
    const u = os.userInfo().username;
    if (u && u.length >= 3 && !GENERIC_HOMES.has(u.toLowerCase())) ids.add(u.toLowerCase());
  } catch {
    // no user info in this environment
  }
  // The subscription token itself must never appear in a transcript.
  const token = readBenchToken().token;
  if (token && token.length >= 12) ids.add(token.toLowerCase());
  const home = os.homedir();
  if (home && home.length > 3) {
    ids.add(home.toLowerCase());
    ids.add(home.replace(/\\/g, '/').toLowerCase());
  }
  return [...ids];
}

export function scanText(text: string, where: string, ids = operatorIdentifiers()): LeakHit[] {
  const hits: LeakHit[] = [];
  const t = decode(text);
  for (const m of t.match(EMAIL) ?? []) {
    if (!/(\.example|@example\.com)$/i.test(m)) hits.push({ where, kind: 'email', sample: mask(m) });
  }
  for (const m of t.matchAll(HOME_PATH)) {
    const name = m[1].trim().toLowerCase();
    if (!GENERIC_HOMES.has(name)) hits.push({ where, kind: 'home_path', sample: mask(m[0]) });
  }
  const lower = t.toLowerCase();
  for (const id of ids) if (lower.includes(id)) hits.push({ where, kind: 'identifier', sample: mask(id) });
  return hits;
}

/** Never print the leaked value itself: first two characters and the length. */
function mask(s: string): string {
  return `${s.slice(0, 2)}*** (${s.length} chars)`;
}

const EXT = new Set(['.json', '.html', '.csv', '.md', '.txt']);

export function scanPaths(paths: string[]): LeakHit[] {
  const hits: LeakHit[] = [];
  const ids = operatorIdentifiers();
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p)) if (n !== 'node_modules' && n !== '.git') walk(join(p, n));
    } else if (EXT.has(extname(p))) hits.push(...scanText(readFileSync(p, 'utf8'), p, ids));
  };
  for (const p of paths) walk(resolve(p));
  return hits;
}

if (process.argv[1]?.endsWith('leak.ts')) {
  const targets = process.argv.slice(2);
  const hits = scanPaths(targets.length ? targets : ['results', 'grading']);
  if (hits.length) {
    console.error(`LEAK CHECK FAILED: ${hits.length} hit(s). Withdraw these files; do not publish.`);
    for (const h of hits.slice(0, 50)) console.error(`  ${h.kind} in ${h.where}: ${h.sample}`);
    process.exit(1);
  }
  console.log('leak check clean');
}
