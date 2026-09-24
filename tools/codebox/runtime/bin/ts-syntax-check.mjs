#!/usr/bin/env node
// Syntax-only TypeScript check (no type resolution, no node_modules needed):
// reports the parser diagnostics of every file given on the command line.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.CODEBOX_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(home, 'runners', 'ts', 'package.json'));
const ts = require('typescript');

let errors = 0;
for (const file of process.argv.slice(2)) {
  const source = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  for (const diag of sf.parseDiagnostics) {
    const { line, character } = sf.getLineAndCharacterOfPosition(diag.start ?? 0);
    process.stderr.write(`${file}:${line + 1}:${character + 1} TS${diag.code}: ${ts.flattenDiagnosticMessageText(diag.messageText, '\n')}\n`);
    errors += 1;
  }
}
process.exit(errors > 0 ? 1 : 0);
