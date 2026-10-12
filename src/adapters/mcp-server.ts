// A minimal MCP server over stdio that serves one task's mock tools to the
// Claude Code CLI. It speaks newline-delimited JSON-RPC 2.0 (initialize,
// tools/list, tools/call, ping) and has no dependencies. After every call it
// writes the world state and the call log into the session directory, which is
// how the adapter reads the final state once the CLI exits.
//
// Usage: node src/adapters/mcp-server.ts <sessionDir>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { World } from '../tools/world.ts';
import { toolsFor } from '../tools/catalog.ts';
import type { Business, Task } from '../types.ts';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: mcp-server.ts <sessionDir>\n');
  process.exit(2);
}

const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const task = read('task.json') as Task;
const business = read('business.json') as Business;
const limits = read('limits.json') as { maxToolCallsPerTurn: number };
const world = new World(business, task);
const defs = toolsFor(task.tools);
const perTurn: Record<number, number> = {};

function currentTurn(): number {
  const f = join(dir, 'turn.txt');
  return existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) || 0 : 0;
}

function persist(): void {
  writeFileSync(join(dir, 'state.json'), JSON.stringify(world.state));
  writeFileSync(join(dir, 'log.json'), JSON.stringify(world.log));
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

persist();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notifications need no answer
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'small-business-agent-bench', version: '1.0.0' },
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.input_schema })) } });
      return;
    case 'tools/call': {
      const turn = currentTurn();
      perTurn[turn] = (perTurn[turn] ?? 0) + 1;
      if (perTurn[turn] > limits.maxToolCallsPerTurn) {
        writeFileSync(join(dir, 'limit.txt'), String(turn));
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{"error":"Tool call limit for this turn reached. Reply to the person now."}' }], isError: true } });
        return;
      }
      const r = world.call(String(params?.name ?? ''), params?.arguments ?? {}, turn);
      persist();
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r.output) }], isError: !r.ok } });
      return;
    }
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
