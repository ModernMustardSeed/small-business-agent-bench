// House style gate: no em or en dash characters, and no time-based pricing
// words, in any text file in the repository.
// Model output inside results is stored with those characters escaped
// (see safeJson and esc in report.ts), so it never trips this check.
//   node src/style.ts

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ROOT } from './tasks.ts';

// Time-based pricing words are banned under the studio's name; built from
// pieces so this file does not trip its own check.
const TERMS = new RegExp(['h' + 'our', '/' + 'hr' + '\\b', 'per ' + 'hr' + '\\b', 'day ' + 'rate', 'time and ' + 'materials', 'time-and-' + 'materials', 't&' + 'm' + '\\b'].join('|'), 'i');

const EXT = new Set(['.ts', '.md', '.json', '.yml', '.yaml', '.html', '.csv', '.txt']);
const SKIP = new Set(['node_modules', '.git', 'pnpm-lock.yaml']);
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
          if (TERMS.test(line)) bad.push(`${p.slice(ROOT.length + 1)}:${i + 1} (time-based pricing word)`);
          if (/[\u2013\u2014]/.test(line)) bad.push(`${p.slice(ROOT.length + 1)}:${i + 1}`);
        });
    }
  }
}

walk(ROOT);
if (bad.length) {
  console.error(`House style violations (em or en dash, or a time-based pricing word):\n${bad.join('\n')}`);
  process.exit(1);
}
console.log('house style clean');
