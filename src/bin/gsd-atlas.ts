#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

function readVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  throw new Error('gsd-atlas: package.json has no version');
}

const args = process.argv.slice(2);
const first = args[0];

if (first === '--version' || first === '-v') {
  process.stdout.write(`gsd-atlas ${readVersion()}\n`);
} else if (first === '--help' || first === '-h') {
  process.stdout.write('Usage: gsd-atlas [--version | -v] [--help | -h]\n');
} else {
  process.stderr.write('gsd-atlas: unknown command\n');
  process.exitCode = 1;
}
