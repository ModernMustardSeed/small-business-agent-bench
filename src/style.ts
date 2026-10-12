// House style gate: no em or en dash characters in any tracked text file.
// Model output inside results is stored with those characters escaped
// (see safeJson and esc in report.ts), so it never trips this check.
//   node src/style.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ROOT } from './tasks.ts';

const EXT = new Set(['.ts', '.md', '.json', '.yml', '.yaml', '.html', '.csv', '.txt']);
const SKIP = new Set(['node_modules', '.git']);
const bad: string[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXT.has(extname(name))) {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/[\u2013\u2014]/.test(line)) bad.push(`${p.slice(ROOT.length + 1)}:${i + 1}`);
        });
    }
  }
}

walk(ROOT);
if (bad.length) {
  console.error(`Em or en dash found:\n${bad.join('\n')}`);
  process.exit(1);
}
console.log('house style clean');
