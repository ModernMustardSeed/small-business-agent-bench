// Claude Code CLI adapter: runs the agent through `claude -p` on a Claude
// subscription, which is the non-metered path Modern Mustard Seed already uses
// for model calls. The mock tools are served to the CLI by a local MCP server
// (mcp-server.ts), so tool use is native, not parsed out of text.
//
// Isolation:
// - ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are removed from the child env.
//   A key that is merely present switches the CLI to metered billing.
// - --system-prompt-file replaces Claude Code's own system prompt.
// - --tools "" turns off every built-in tool; only the task's MCP tools exist.
// - --setting-sources "" and an empty temp working directory keep the
//   operator's settings, hooks, memory and CLAUDE.md out of the run.
// - --strict-mcp-config ignores every other MCP server on the machine.
//
// Cost: the CLI reports total_cost_usd, the metered-equivalent price of the
// tokens used. On a subscription nothing is billed per token; the run records
// that figure so a metered run can be estimated from it.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, JsonOutput, RunInput, RunOutput } from './adapter.ts';
import { addUsage, zeroUsage } from './adapter.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(here, 'mcp-server.ts');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
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
    return new Promise((res) => {
      const p = spawn(CLAUDE_BIN, ['--version'], { env: childEnv(), stdio: 'ignore' });
      p.on('error', () => res('the claude CLI is not installed'));
      p.on('exit', (code) => res(code === 0 ? null : 'the claude CLI did not start'));
    });
  }

  async runTask(input: RunInput): Promise<RunOutput> {
    const session = mkdtempSync(join(tmpdir(), 'sbab-'));
    const work = mkdtempSync(join(tmpdir(), 'sbab-cwd-'));
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
        const child = spawn(CLAUDE_BIN, args, { cwd: work, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
      rmSync(session, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>, timeoutMs: number): Promise<JsonOutput> {
    const session = mkdtempSync(join(tmpdir(), 'sbab-judge-'));
    try {
      const systemFile = join(session, 'system.txt');
      writeFileSync(systemFile, system);
      const args = [...baseArgs(this.model, this.effort, systemFile), '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', ''];
      const out = await new Promise<string>((res, rej) => {
        const child = spawn(CLAUDE_BIN, args, { cwd: session, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
      rmSync(session, { recursive: true, force: true });
    }
  }
}
