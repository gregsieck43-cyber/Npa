import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const violations = [];
function scan(dir) {
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, file.name);
    if (file.isDirectory()) scan(path);
    else if (/\.(tsx?|mjs)$/.test(file.name)) {
      const source = readFileSync(path, 'utf8');
      if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(source)) violations.push(`${path}: empty catch`);
      if (/\beval\s*\(/.test(source)) violations.push(`${path}: eval`);
      if (/\bdebugger\s*;/.test(source)) violations.push(`${path}: debugger`);
      if (/AIza[\w-]{30}|sk-[A-Za-z0-9]{24,}/.test(source)) violations.push(`${path}: secret-like literal`);
    }
  }
}
scan('src'); scan('scripts'); scan('ide/extension/src'); scan('ide/extension/ui');
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log('Source boundary checks passed. TypeScript strict check is required separately.');
