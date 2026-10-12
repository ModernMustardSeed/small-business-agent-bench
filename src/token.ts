// Where the claude-code adapter gets its subscription token.
//
// 1. A file: BENCH_OAUTH_TOKEN_FILE, default <home>/.bench/oauth-token.txt.
//    Local runs use this, so the token never sits in a user-level environment
//    variable, where it would take over auth in every interactive Claude Code
//    session on the machine.
// 2. CLAUDE_CODE_OAUTH_TOKEN in this process's environment. CI uses this, set
//    from a repository secret.
//
// The token is injected only into the clean-room child environment. A token
// file inside a git work tree is refused, so it can never be committed.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

export function tokenFilePath(): string {
  return resolve(process.env.BENCH_OAUTH_TOKEN_FILE || join(homedir(), '.bench', 'oauth-token.txt'));
}

/** The nearest directory at or above `p` that holds a .git entry, or null. */
export function gitWorkTreeAbove(p: string): string | null {
  let dir = dirname(p);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface TokenResult {
  token: string | null;
  source: 'file' | 'env' | null;
  problem: string | null;
}

export function readBenchToken(): TokenResult {
  const file = tokenFilePath();
  if (existsSync(file) && statSync(file).isFile()) {
    const repo = gitWorkTreeAbove(file);
    if (repo) return { token: null, source: null, problem: `The token file ${file} is inside the git work tree ${repo}. Move it outside every repository.` };
    const token = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
    if (token) return { token, source: 'file', problem: null };
  }
  const env = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').replace(/^﻿/, '').trim();
  if (env) return { token: env, source: 'env', problem: null };
  return {
    token: null,
    source: null,
    problem: `No subscription token. Put the output of \`claude setup-token\` in ${file} (or point BENCH_OAUTH_TOKEN_FILE at it); in CI set CLAUDE_CODE_OAUTH_TOKEN from a secret. A logged-in profile leaks the operator account into every run, so the adapter will not use it.`,
  };
}
