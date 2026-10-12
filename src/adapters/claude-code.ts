// Claude Code CLI adapter: runs the agent through `claude -p` on a Claude
// subscription, which is the non-metered path Modern Mustard Seed already uses
// for model calls. The mock tools are served to the CLI by a local MCP server
// (mcp-server.ts), so tool use is native, not parsed out of text.
//
// Isolation. A logged-in Claude Code profile attaches the operator's account
// email, working directory, OS and date to every request, even with a custom
// system prompt (found 2026-10-12 with an unpublished canary task). So each run
// gets a clean room:
// - Auth comes only from CLAUDE_CODE_OAUTH_TOKEN (made once with
//   `claude setup-token`). The child gets a fresh, empty CLAUDE_CONFIG_DIR, so
//   no account profile, email, memory, settings, hooks, plugins or sessions
//   exist for it. Without the token the adapter refuses to run.
// - The child environment is an allowlist, not the parent's environment minus
//   a few keys: HOME, USERPROFILE, APPDATA, TEMP and the rest point inside the
//   clean room, and no API key, username or account variable is passed.
// - The working directory is outside the user profile (BENCH_WORKDIR, default
//   a sbab-work folder at the drive root), so no path names the operator.
// - --system-prompt-file replaces Claude Code's own system prompt, --tools ""
//   turns off every built-in tool, --setting-sources "" and
//   --strict-mcp-config load nothing from the machine.
// - src/leak.ts scans every transcript; the runner refuses to publish a run
//   that contains an operator identifier.
//
// Cost: the CLI reports total_cost_usd, the metered-equivalent price of the
// tokens used. On a subscription nothing is billed per token; the run records
// that figure so a metered run can be estimated from it.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, JsonOutput, RunInput, RunOutput } from './adapter.ts';
import { addUsage, zeroUsage } from './adapter.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(here, 'mcp-server.ts');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/** Root for clean rooms: outside the user profile so no path names the operator. */
function workRoot(): string {
  const want = process.env.BENCH_WORKDIR || join(parse(tmpdir()).root, 'sbab-work');
  try {
    mkdirSync(want, { recursive: true });
    return want;
  } catch {
    return tmpdir();
  }
}

/** A fresh clean room: config dir, home and temp for one child process. */
export function cleanRoom(label: string): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(workRoot(), `${label}-`));
  const home = join(root, 'home');
  const cfg = join(root, 'cfg');
  const tmp = join(root, 'tmp');
  for (const d of [home, cfg, tmp, join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')]) mkdirSync(d, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: cfg,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    USERNAME: 'bench',
    USER: 'bench',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  return { root, env };
}

export function isolationProblem(): string | null {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return 'CLAUDE_CODE_OAUTH_TOKEN is not set. Isolated runs need a token from `claude setup-token`; a logged-in profile leaks the operator account into every run, so the adapter will not use it.';
  }
  return null;
}

function baseArgs(model: string, effort: string, systemFile: string): string[] {
  return [
    '-p',
    '--model', model,
    '--effort', effort,
    '--system-prompt-file', systemFile,
    '--setting-sources', '',
    '--no-session-persistence',
    '--strict-mcp-config',
  ];
}

export class ClaudeCodeAdapter implements Adapter {
  id = 'claude-code' as const;
  billing = 'subscription' as const;
  model: string;
  effort: string;

  constructor(model: string, effort: string) {
    this.model = model;
    this.effort = effort;
  }

  async unavailable(): Promise<string | null> {
    const why = isolationProblem();
    if (why) return why;
    return new Promise((res) => {
      const p = spawn(CLAUDE_BIN, ['--version'], { env: cleanRoom('probe').env, stdio: 'ignore' });
      p.on('error', () => res('the claude CLI is not installed'));
      p.on('exit', (code) => res(code === 0 ? null : 'the claude CLI did not start'));
    });
  }

  async runTask(input: RunInput): Promise<RunOutput> {
    const why = isolationProblem();
    if (why) return { replies: [], usage: zeroUsage(), cost_usd: 0, stop: 'error', error: why };
    const room = cleanRoom('run');
    const session = join(room.root, 'session');
    const work = join(room.root, 'work');
    mkdirSync(session);
    mkdirSync(work);
    try {
      writeFileSync(join(session, 'task.json'), JSON.stringify({ ...input.world.task, reference: undefined, rubric: undefined, checks: [], judge: [] }));
      writeFileSync(join(session, 'business.json'), JSON.stringify(input.world.business));
      writeFileSync(join(session, 'limits.json'), JSON.stringify({ maxToolCallsPerTurn: input.maxToolCallsPerTurn }));
      writeFileSync(join(session, 'turn.txt'), '0');
      const systemFile = join(session, 'system.txt');
      writeFileSync(systemFile, input.system);
      const mcpFile = join(session, 'mcp.json');
      writeFileSync(
        mcpFile,
        JSON.stringify({ mcpServers: { bench: { type: 'stdio', command: process.execPath, args: [MCP_SERVER, session] } } }),
      );
      const args = [
        ...baseArgs(this.model, this.effort, systemFile),
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--mcp-config', mcpFile,
        '--tools', '',
        '--allowedTools', 'mcp__bench',
      ];

      const replies: string[] = [];
      let usage = zeroUsage();
      let cost = 0;
      let stop: RunOutput['stop'] = 'ok';
      let error: string | undefined;

      await new Promise<void>((done) => {
        const child = spawn(CLAUDE_BIN, args, { cwd: work, env: room.env, stdio: ['pipe', 'pipe', 'pipe'] });
        let turn = 0;
        let buf = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stop = 'timeout';
          error = `no answer within ${input.timeoutMs} ms`;
          child.kill();
        }, input.timeoutMs);
        const sendTurn = (i: number) => {
          writeFileSync(join(session, 'turn.txt'), String(i));
          child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: input.turns[i] } }) + '\n');
        };
        child.stdout.on('data', (d) => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: any;
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type !== 'result') continue;
            usage = addUsage(usage, ev.usage);
            cost += Number(ev.total_cost_usd ?? 0);
            replies.push(typeof ev.result === 'string' ? ev.result.trim() : '');
            if (ev.is_error) {
              stop = 'error';
              error = String(ev.result ?? ev.subtype ?? 'error').slice(0, 500);
            }
            if (/refus/i.test(String(ev.stop_reason ?? ''))) stop = 'refusal';
            turn += 1;
            if (stop === 'ok' && turn < input.turns.length) sendTurn(turn);
            else child.stdin.end();
          }
        });
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', (e) => {
          stop = 'error';
          error = e.message;
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (stop === 'ok' && replies.length < input.turns.length) {
            stop = 'error';
            error = `claude exited ${code} after ${replies.length} of ${input.turns.length} turns. ${stderr.slice(0, 400)}`;
          }
          done();
        });
        sendTurn(0);
      });

      // The MCP server owns the world during the run; copy its final state back.
      if (existsSync(join(session, 'state.json'))) input.world.state = JSON.parse(readFileSync(join(session, 'state.json'), 'utf8'));
      if (existsSync(join(session, 'log.json'))) input.world.log.push(...JSON.parse(readFileSync(join(session, 'log.json'), 'utf8')));
      if (stop === 'ok' && existsSync(join(session, 'limit.txt'))) stop = 'max_tool_calls';
      return { replies, usage, cost_usd: cost, stop, error };
    } finally {
      rmSync(room.root, { recursive: true, force: true });
    }
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>, timeoutMs: number): Promise<JsonOutput> {
    const why = isolationProblem();
    if (why) throw new Error(why);
    const room = cleanRoom('judge');
    const session = join(room.root, 'work');
    mkdirSync(session);
    try {
      const systemFile = join(session, 'system.txt');
      writeFileSync(systemFile, system);
      const args = [...baseArgs(this.model, this.effort, systemFile), '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', ''];
      const out = await new Promise<string>((res, rej) => {
        const child = spawn(CLAUDE_BIN, args, { cwd: session, env: room.env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('error', rej);
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) res(stdout);
          else rej(new Error(`claude judge exited ${code}: ${stderr.slice(0, 300)} ${stdout.slice(0, 300)}`));
        });
        child.stdin.end(user);
      });
      const r = JSON.parse(out);
      if (r.is_error) throw new Error(`judge error: ${String(r.result).slice(0, 300)}`);
      const json = r.structured_output ?? JSON.parse(String(r.result).replace(/^```(?:json)?\s*|\s*```$/g, ''));
      return { json, usage: addUsage(zeroUsage(), r.usage), cost_usd: Number(r.total_cost_usd ?? 0) };
    } finally {
      rmSync(room.root, { recursive: true, force: true });
    }
  }
}
