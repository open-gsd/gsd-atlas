import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createPilotOracle, type PilotOracle } from './oracle-lib.ts';

// Methods of generic classes: a call through `Box<string>` or a subclass receiver resolves to an
// instantiated member symbol, not the declared one. The oracle must still credit it to the declaration.
const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  'lib/leaf.ts': `export function leaf(x: unknown): boolean { return Array.isArray(x); }\n`,
  'lib/other.ts': `export function leaf(x: unknown): boolean { return x === null; }\n`,
  'lib/box.ts': [
    `import { leaf } from './leaf';`,
    `export class Box<T> {`,
    `  get(v: T): boolean { return leaf(v); }`,
    `}`,
    `export class Sub extends Box<number> {}`,
    `export type StrBox = Box<string>;`,
    `export class Plain { run(): boolean { return leaf(1); } }`,
    ``,
  ].join('\n'),
  'use/via-instantiation.ts': `import { Box } from '../lib/box';\nconst b: Box<string> = new Box<string>();\nexport const r = b.get('a');\n`,
  'use/via-subclass.ts': `import { Sub } from '../lib/box';\nexport const r = new Sub().get(1);\n`,
  'use/via-alias.ts': `import type { StrBox } from '../lib/box';\ndeclare const b: StrBox;\nexport const r = b.get('a');\n`,
  'use/via-plain.ts': `import { Plain } from '../lib/box';\nexport const r = new Plain().run();\n`,
  // same method name on an unrelated generic class: must NOT be credited
  'use/unrelated.ts': `class Other<T> { get(v: T): T { return v; } }\nexport const r = new Other<string>().get('a');\n`,
  'use/other-leaf.ts': `import { leaf } from '../lib/other';\nexport const r = leaf(2);\n`,
};

describe('oracle: members of instantiated generic types and same-name symbols', () => {
  let dir = '';
  let o: PilotOracle;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-oracle-gen-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    o = createPilotOracle({ root: dir, tsconfig: 'tsconfig.json', include: (rel) => rel.endsWith('.ts') });
  });
  after(() => {
    o.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('impact depth two credits calls through Box<string>, a subclass and a type alias', () => {
    const r = o.impactDepthTwo('lib/leaf.ts', 'leaf');
    assert.deepEqual(r.direct, ['lib/box.ts']);
    assert.deepEqual(r.viaCallers, ['use/via-alias.ts', 'use/via-instantiation.ts', 'use/via-plain.ts', 'use/via-subclass.ts']);
  });

  it('a same-named function in another file stays a different symbol', () => {
    assert.deepEqual(o.callSites('lib/other.ts', 'leaf').map((c) => c.file), ['use/other-leaf.ts']);
    assert.ok(!o.callSites('lib/leaf.ts', 'leaf').some((c) => c.file === 'use/other-leaf.ts'));
  });
});
