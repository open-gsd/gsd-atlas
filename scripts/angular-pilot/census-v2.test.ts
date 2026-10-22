import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rowsFromCensus } from './census-v2.ts';

const raw = (name: string, declFile: string, declKind: string, over: Record<string, unknown> = {}) => ({
  name,
  files: ['packages/a/x.ts', 'packages/b/x.ts', 'packages/c/x.ts'],
  kinds: [declKind],
  declFile,
  declKind,
  grepFiles: 70,
  callSiteFiles: 4,
  subtypeCount: 0,
  ...over,
});

describe('rowsFromCensus', () => {
  it('turns census rows into v2 rows with other declaration counts, other kinds and the file date', () => {
    const rows = rowsFromCensus(
      [raw('Foo', 'packages/a/x.ts', 'interface'), raw('Foo', 'packages/b/x.ts', 'class'), raw('Foo', 'packages/c/x.ts', 'class')],
      new Map([['packages/a/x.ts', '2026-03-04'], ['packages/b/x.ts', '2025-01-01']]),
    );
    assert.equal(rows.length, 3);
    const a = rows.find((r) => r.file === 'packages/a/x.ts')!;
    assert.equal(a.otherDeclFiles, 2);
    assert.deepEqual(a.otherKinds.sort(), ['class', 'class']);
    assert.equal(a.fileLastChanged, '2026-03-04');
    assert.equal(a.directSubtypes, 0);
    assert.equal(a.callSiteFiles, 4);
    assert.equal(rows.find((r) => r.file === 'packages/c/x.ts')!.fileLastChanged, '');
  });
});
