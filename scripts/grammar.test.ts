import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Language, Parser, Query } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import { parseGrammarLock } from '../src/lang/grammar-lock.ts';
import { parseCliVersion } from './ensure-tree-sitter.ts';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeTempDir } from '../src/test-kit/index.ts';
import type { GrammarLock } from '../src/lang/grammar-lock.ts';
import {
  GrammarBuildError,
  checkAgainstLock,
  prepareSource,
  serializeLock,
  sha256Hex,
  updateLockRefusal,
  updatedLock,
} from './grammar-build.ts';
import { compareHashes } from './grammar-verify.ts';
import { FIXTURES } from './toy-fixtures.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const toyDir = path.join(repoRoot, 'test', 'fixtures', 'modules', 'toy');

function readToyLock() {
  const text = fs.readFileSync(path.join(toyDir, 'grammar.lock'), 'utf8');
  const parsed = parseGrammarLock(text, 'test/fixtures/modules/toy/grammar.lock');
  assert.equal(parsed.ok, true, 'toy grammar.lock must parse');
  if (!parsed.ok) {
    throw new Error('unreachable');
  }
  return parsed.lock;
}

function hasErrorNode(node: { type: string; children: Array<unknown> }): boolean {
  if (node.type === 'ERROR') {
    return true;
  }
  return (node.children as Array<{ type: string; children: Array<unknown> }>).some(hasErrorNode);
}

describe('parseCliVersion', () => {
  it('extracts the version from tree-sitter --version output', () => {
    assert.equal(parseCliVersion('tree-sitter 0.27.1 (abc123)'), '0.27.1');
    assert.equal(parseCliVersion('tree-sitter 0.27.1\n'), '0.27.1');
  });

  it('returns null for unparsable text', () => {
    assert.equal(parseCliVersion('command not found'), null);
    assert.equal(parseCliVersion(''), null);
  });
});

const LINUX_HASH = 'c'.repeat(64);
const WINDOWS_HASH = 'd'.repeat(64);

/** A lock whose committed wasm is the linux build and whose windows rebuild differs by design. */
function perPlatformLock(): GrammarLock {
  return {
    ...readToyLock(),
    wasm: {
      file: 'grammar.wasm',
      sha256: LINUX_HASH,
      platforms: { 'linux-x64': LINUX_HASH, 'darwin-arm64': LINUX_HASH, 'win32-x64': WINDOWS_HASH },
    },
  };
}

describe('toy grammar.lock (per-platform hashes, lockVersion 2)', () => {
  it('records the CI-measured hashes: linux-x64 and darwin-arm64 are the committed wasm, win32-x64 differs', () => {
    const lock = readToyLock();
    const committed = 'ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a';
    const windows = 'cba9dce1c2048b2fc06d408d0c7d0f57c5ee026652a385e8c9080046bdb58853';
    assert.equal(lock.wasm.sha256, committed);
    assert.deepEqual(lock.wasm.platforms, { 'linux-x64': committed, 'darwin-arm64': committed, 'win32-x64': windows });
  });
});

describe('checkAgainstLock', () => {
  const lock = perPlatformLock();

  it('returns null when the rebuild equals this platform entry', () => {
    assert.equal(checkAgainstLock(lock, LINUX_HASH, 'linux', 'x64'), null);
    assert.equal(checkAgainstLock(lock, WINDOWS_HASH, 'win32', 'x64'), null);
  });

  it('checks each platform against its own entry, never another platform entry', () => {
    const onWindows = checkAgainstLock(lock, LINUX_HASH, 'win32', 'x64');
    assert.ok(onWindows !== null);
    assert.ok(onWindows.includes('win32-x64'));
    assert.ok(onWindows.includes(WINDOWS_HASH));
    assert.ok(onWindows.includes(LINUX_HASH));
    assert.notEqual(checkAgainstLock(lock, WINDOWS_HASH, 'linux', 'x64'), null);
  });

  it('names expected, computed and the update hint on inequality', () => {
    const text = checkAgainstLock(lock, 'e'.repeat(64), 'linux', 'x64');
    assert.ok(text !== null);
    assert.ok(text.includes(LINUX_HASH));
    assert.ok(text.includes('e'.repeat(64)));
    assert.ok(text.includes('--update-platform'));
    assert.ok(text.includes('--update-lock'));
  });

  it('fails, never passes, for a platform with no entry, naming the platform key', () => {
    const text = checkAgainstLock(lock, LINUX_HASH, 'linux', 'arm64');
    assert.ok(text !== null);
    assert.ok(text.includes('linux-arm64'));
    assert.ok(text.includes('--update-platform'));
    const unsupported = checkAgainstLock(lock, LINUX_HASH, 'freebsd', 'x64');
    assert.ok(unsupported !== null);
    assert.ok(unsupported.includes('freebsd-x64'));
  });
});

describe('updatedLock / updateLockRefusal / serializeLock', () => {
  it('--update-platform records one platform and never touches the committed hash or other entries', () => {
    const next = updatedLock(perPlatformLock(), 'win32-x64', 'e'.repeat(64), false);
    assert.equal(next.wasm.sha256, LINUX_HASH);
    assert.equal(next.wasm.platforms['win32-x64'], 'e'.repeat(64));
    assert.equal(next.wasm.platforms['linux-x64'], LINUX_HASH);
    assert.equal(next.wasm.platforms['darwin-arm64'], LINUX_HASH);
  });

  it('--update-lock replaces the committed hash and this platform entry, and keeps the others', () => {
    const next = updatedLock(perPlatformLock(), 'linux-x64', 'e'.repeat(64), true);
    assert.equal(next.wasm.sha256, 'e'.repeat(64));
    assert.equal(next.wasm.platforms['linux-x64'], 'e'.repeat(64));
    assert.equal(next.wasm.platforms['win32-x64'], WINDOWS_HASH);
  });

  it('allows --update-lock only on the artifact platforms', () => {
    assert.equal(updateLockRefusal('linux', 'x64'), null);
    assert.equal(updateLockRefusal('darwin', 'arm64'), null);
    for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['freebsd', 'x64']] as const) {
      const text = updateLockRefusal(platform, arch);
      assert.ok(text !== null);
      assert.ok(text.includes('--update-platform'));
      assert.ok(text.includes(`${platform}-${arch}`));
    }
  });

  it('serialises platforms in PLATFORM_KEYS order with LF endings and round-trips through the parser', () => {
    const shuffled: GrammarLock = {
      ...perPlatformLock(),
      wasm: {
        file: 'grammar.wasm',
        sha256: LINUX_HASH,
        platforms: { 'win32-x64': WINDOWS_HASH, 'darwin-arm64': LINUX_HASH, 'linux-x64': LINUX_HASH },
      },
    };
    const text = serializeLock(shuffled);
    assert.ok(text.endsWith('\n'));
    assert.equal(text.includes('\r'), false);
    assert.ok(text.indexOf('linux-x64') < text.indexOf('darwin-arm64'));
    assert.ok(text.indexOf('darwin-arm64') < text.indexOf('win32-x64'));
    const reparsed = parseGrammarLock(text);
    assert.equal(reparsed.ok, true);
    if (reparsed.ok) {
      assert.deepEqual(reparsed.lock, shuffled);
    }
  });

  it('writes the committed toy grammar.lock byte-for-byte in canonical form', () => {
    const text = fs.readFileSync(path.join(toyDir, 'grammar.lock'), 'utf8');
    assert.equal(serializeLock(readToyLock()), text);
  });
});

describe('sha256Hex', () => {
  it('hashes bytes to 64 lowercase hex', () => {
    assert.equal(
      sha256Hex(Buffer.from('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

async function loadToy(): Promise<Language> {
  const lock = readToyLock();
  await Parser.init();
  return Language.load(new Uint8Array(fs.readFileSync(path.join(toyDir, lock.wasm.file))));
}

/** Parse `text`, run `fn` on the root, and free every WASM object (Pattern 3). */
async function withTree<T>(text: string, fn: (root: Node, language: Language) => T): Promise<T> {
  const language = await loadToy();
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const tree = parser.parse(text);
    assert.ok(tree !== null);
    try {
      return fn(tree.rootNode, language);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

function readFixture(relative: string): Buffer {
  return fs.readFileSync(path.join(toyDir, relative));
}

/** Decode a fixture the way the engine will: UTF-8, leading BOM stripped. */
function fixtureText(relative: string): string {
  return readFixture(relative).toString('utf8').replace(/^﻿/, '');
}

function span(node: Node): [number, number, number, number] {
  return [node.startPosition.row, node.startPosition.column, node.endPosition.row, node.endPosition.column];
}

function findAll(root: Node, type: string): Node[] {
  return root.descendantsOfType(type).filter((n): n is Node => n !== null);
}

describe('toy fixtures: exact bytes', () => {
  it('commits exactly the generated files, byte for byte', () => {
    for (const [relative, bytes] of Object.entries(FIXTURES)) {
      assert.ok(readFixture(relative).equals(bytes), `${relative} differs from scripts/toy-fixtures.ts`);
    }
    // The `<fixture>.golden.json` files belong to `lang test` (plan 01-14) and have their own checks.
    assert.deepEqual(
      fs
        .readdirSync(path.join(toyDir, 'fixtures'))
        .filter((name) => !name.endsWith('.golden.json'))
        .sort(),
      ['basic.toy', 'bom.toy', 'crlf.toy', 'emoji.toy'],
    );
    assert.deepEqual(fs.readdirSync(path.join(toyDir, 'fixtures-negative')), ['broken.toy']);
  });

  it('keeps basic.toy and emoji.toy LF-only', () => {
    for (const name of ['fixtures/basic.toy', 'fixtures/emoji.toy']) {
      assert.equal(readFixture(name).includes(0x0d), false, `${name} must not contain CR`);
    }
  });

  it('writes every line break of crlf.toy as CRLF with no lone LF', () => {
    const bytes = readFixture('fixtures/crlf.toy');
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x0a) {
        assert.equal(bytes[i - 1], 0x0d, `lone LF at byte ${String(i)}`);
      }
      if (bytes[i] === 0x0d) {
        assert.equal(bytes[i + 1], 0x0a, `lone CR at byte ${String(i)}`);
      }
    }
    assert.ok(bytes.includes(0x0d));
    assert.equal(bytes.toString('utf8').replaceAll('\r\n', '\n'), readFixture('fixtures/basic.toy').toString('utf8'));
  });

  it('starts bom.toy with the UTF-8 byte order mark', () => {
    assert.deepEqual([...readFixture('fixtures/bom.toy').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  it('puts the emoji and the e-acute in emoji.toy as UTF-8', () => {
    const bytes = readFixture('fixtures/emoji.toy');
    assert.ok(bytes.includes(Buffer.from([0xf0, 0x9f, 0x98, 0x80])));
    assert.ok(bytes.includes(Buffer.from([0xc3, 0xa9])));
  });
});

describe('toy queries', () => {
  const queryFiles = ['tags.scm', 'refs.scm', 'imports.scm'];

  for (const file of queryFiles) {
    it(`compiles ${file} against the committed wasm`, async () => {
      const language = await loadToy();
      const query = new Query(language, fs.readFileSync(path.join(toyDir, 'queries', file), 'utf8'));
      query.delete();
    });
  }

  it('captures exactly the definitions, call and import of basic.toy', async () => {
    const text = fixtureText('fixtures/basic.toy');
    const found = await withTree(text, (root, language) => {
      const out: Array<[string, string]> = [];
      for (const file of queryFiles) {
        const query = new Query(language, fs.readFileSync(path.join(toyDir, 'queries', file), 'utf8'));
        try {
          for (const capture of query.captures(root)) {
            out.push([capture.name, capture.node.text]);
          }
        } finally {
          query.delete();
        }
      }
      return out;
    });
    const byName = (name: string) => found.filter(([n]) => n === name).map(([, t]) => t);
    assert.equal(byName('definition.function').length, 1);
    assert.ok(byName('definition.function')[0]?.startsWith('fn main'));
    assert.equal(byName('definition.type').length, 1);
    assert.ok(byName('definition.type')[0]?.startsWith('type Widget'));
    assert.deepEqual(byName('name'), ['main', 'Widget']);
    assert.deepEqual(byName('reference.call'), ['helper']);
    assert.deepEqual(byName('import.path'), ['"lib/util"']);
    assert.equal(found.length, 6);
  });
});

describe('toy fixtures: parse positions (0-based line, 0-based UTF-16 column, end exclusive)', () => {
  it('parses every measured fixture without an ERROR node', async () => {
    for (const name of ['basic', 'emoji', 'crlf', 'bom']) {
      const text = fixtureText(`fixtures/${name}.toy`);
      const hasError = await withTree(text, (root) => root.hasError);
      assert.equal(hasError, false, `${name}.toy must parse cleanly`);
    }
  });

  it('counts the emoji as two UTF-16 units in emoji.toy', async () => {
    const text = fixtureText('fixtures/emoji.toy');
    const result = await withTree(text, (root) => ({
      string: span(findAll(root, 'string')[0] as Node),
      name: span((findAll(root, 'definition')[0] as Node).childForFieldName('name') as Node),
      target: span((findAll(root, 'call_stmt')[0] as Node).childForFieldName('target') as Node),
    }));
    assert.deepEqual(result.string, [1, 4, 1, 10]);
    assert.deepEqual(result.name, [2, 3, 2, 8]);
    assert.deepEqual(result.target, [3, 2, 3, 6]);
  });

  it('counts rows by LF only in crlf.toy', async () => {
    const text = fixtureText('fixtures/crlf.toy');
    const target = await withTree(text, (root) =>
      span((findAll(root, 'call_stmt')[0] as Node).childForFieldName('target') as Node),
    );
    assert.deepEqual(target, [3, 2, 3, 8]);
  });

  it('puts the name at line 0 columns 3 to 4 in bom.toy once the BOM is stripped', async () => {
    const text = fixtureText('fixtures/bom.toy');
    const name = await withTree(text, (root) =>
      span((findAll(root, 'definition')[0] as Node).childForFieldName('name') as Node),
    );
    assert.deepEqual(name, [0, 3, 0, 4]);
  });

  it('produces ERROR nodes for the negative fixture', async () => {
    const text = fixtureText('fixtures-negative/broken.toy');
    const hasError = await withTree(text, (root) => root.hasError && findAll(root, 'ERROR').length > 0);
    assert.equal(hasError, true);
  });
});

describe('prepareSource with an upstream archive (hermetic: no network, no wasi toolchain)', () => {
  /** tar.gz of `entries` (relative path -> text) under a single top directory, via the system tar. */
  function makeArchive(root: string, topDir: string, entries: Record<string, string>): string {
    const stage = path.join(root, 'stage');
    for (const [relative, text] of Object.entries(entries)) {
      const target = path.join(stage, topDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    // Relative paths and cwd: GNU tar on Windows reads a drive letter as a remote host.
    const result = spawnSync('tar', ['-czf', 'archive.tar.gz', '-C', 'stage', topDir], { cwd: root });
    assert.equal(result.status, 0, String(result.stderr));
    return path.join(root, 'archive.tar.gz');
  }

  const grammarJs = fs.readFileSync(path.join(toyDir, 'grammar', 'grammar.js'), 'utf8');

  function patchAddingComment(): string {
    const [l1, l2, l3] = grammarJs.split('\n');
    return `--- a/grammar.js\n+++ b/grammar.js\n@@ -1,3 +1,4 @@\n ${l1}\n ${l2}\n+// patched by the hermetic test\n ${l3}\n`;
  }

  function upstreamLock(archive: string, archiveSha256: string, patches: string[], subdir?: string): GrammarLock {
    const lock = readToyLock();
    return {
      ...lock,
      source: {
        type: 'upstream',
        url: pathToFileURL(archive).href,
        ref: 'test',
        archiveSha256,
        ...(subdir === undefined ? {} : { subdir }),
      },
      patches,
    };
  }

  it('verifies the archive hash, extracts with one leading directory stripped and applies the patch', async () => {
    const tmp = makeTempDir();
    try {
      const archive = makeArchive(tmp.path, 'toy-1.0', { 'grammar.js': grammarJs });
      const moduleDir = path.join(tmp.path, 'module');
      fs.mkdirSync(path.join(moduleDir, 'patches'), { recursive: true });
      fs.writeFileSync(path.join(moduleDir, 'patches', '0001-comment.patch'), patchAddingComment());
      const lock = upstreamLock(archive, sha256Hex(fs.readFileSync(archive)), ['patches/0001-comment.patch']);
      const workDir = path.join(tmp.path, 'work');
      const prepared = await prepareSource(lock, moduleDir, workDir);
      assert.equal(prepared.patchesApplied, 1);
      const extracted = fs.readFileSync(path.join(prepared.dir, 'grammar.js'), 'utf8');
      assert.ok(extracted.includes('// patched by the hermetic test'));
      assert.ok(extracted.includes("name: 'atlas_toy'"));
    } finally {
      tmp.cleanup();
    }
  });

  it('honours the lock subdir', async () => {
    const tmp = makeTempDir();
    try {
      const archive = makeArchive(tmp.path, 'repo-abc', { 'tree-sitter-x/grammar.js': grammarJs, 'README': 'x' });
      const lock = upstreamLock(archive, sha256Hex(fs.readFileSync(archive)), [], 'tree-sitter-x');
      const prepared = await prepareSource(lock, tmp.path, path.join(tmp.path, 'work'));
      assert.equal(prepared.patchesApplied, 0);
      assert.ok(fs.existsSync(path.join(prepared.dir, 'grammar.js')));
    } finally {
      tmp.cleanup();
    }
  });

  it('fails with archive_hash_mismatch when archiveSha256 is wrong', async () => {
    const tmp = makeTempDir();
    try {
      const archive = makeArchive(tmp.path, 'toy-1.0', { 'grammar.js': grammarJs });
      const lock = upstreamLock(archive, '0'.repeat(64), []);
      await assert.rejects(
        prepareSource(lock, tmp.path, path.join(tmp.path, 'work')),
        (error: unknown) => error instanceof GrammarBuildError && error.code === 'archive_hash_mismatch',
      );
    } finally {
      tmp.cleanup();
    }
  });

  it('fails with patch_failed naming the patch that does not apply', async () => {
    const tmp = makeTempDir();
    try {
      const archive = makeArchive(tmp.path, 'toy-1.0', { 'grammar.js': grammarJs });
      const moduleDir = path.join(tmp.path, 'module');
      fs.mkdirSync(path.join(moduleDir, 'patches'), { recursive: true });
      fs.writeFileSync(
        path.join(moduleDir, 'patches', '0002-bad.patch'),
        '--- a/grammar.js\n+++ b/grammar.js\n@@ -1,1 +1,1 @@\n-this line does not exist\n+replacement\n',
      );
      const lock = upstreamLock(archive, sha256Hex(fs.readFileSync(archive)), ['patches/0002-bad.patch']);
      await assert.rejects(
        prepareSource(lock, moduleDir, path.join(tmp.path, 'work')),
        (error: unknown) =>
          error instanceof GrammarBuildError &&
          error.code === 'patch_failed' &&
          error.message.includes('patches/0002-bad.patch'),
      );
    } finally {
      tmp.cleanup();
    }
  });

});

describe('compareHashes (grammar:verify decision)', () => {
  const lock = perPlatformLock();

  it('passes on linux when both rebuilds equal the linux entry and the committed wasm equals wasm.sha256', () => {
    assert.equal(compareHashes(lock, LINUX_HASH, LINUX_HASH, LINUX_HASH, 'linux', 'x64'), null);
  });

  it('passes on windows when the rebuild equals the windows entry although it differs from the committed wasm', () => {
    assert.equal(compareHashes(lock, WINDOWS_HASH, WINDOWS_HASH, LINUX_HASH, 'win32', 'x64'), null);
  });

  it('still pins the committed wasm on windows: a changed committed file fails', () => {
    const text = compareHashes(lock, WINDOWS_HASH, WINDOWS_HASH, WINDOWS_HASH, 'win32', 'x64');
    assert.ok(text !== null);
    assert.ok(text.includes('win32-x64'));
  });

  it('fails on windows when the rebuild equals the linux hash (it must match its own entry)', () => {
    assert.notEqual(compareHashes(lock, LINUX_HASH, LINUX_HASH, LINUX_HASH, 'win32', 'x64'), null);
  });

  it('names the platform key, both entries, both builds and the committed file on any disagreement', () => {
    const other = 'f'.repeat(64);
    for (const [first, second, committed] of [
      [other, LINUX_HASH, LINUX_HASH],
      [LINUX_HASH, other, LINUX_HASH],
      [LINUX_HASH, LINUX_HASH, other],
    ] as const) {
      const text = compareHashes(lock, first, second, committed, 'linux', 'x64');
      assert.ok(text !== null);
      assert.ok(text.includes('linux-x64'));
      assert.ok(text.includes(lock.wasm.sha256));
      assert.ok(text.includes(first));
      assert.ok(text.includes(second));
      assert.ok(text.includes(committed));
    }
  });

  it('fails, never passes, on a platform with no entry, naming the platform key and the update hint', () => {
    const text = compareHashes(lock, LINUX_HASH, LINUX_HASH, LINUX_HASH, 'linux', 'arm64');
    assert.ok(text !== null);
    assert.ok(text.includes('linux-arm64'));
    assert.ok(text.includes('--update-platform'));
  });
});

describe('committed toy grammar.wasm', () => {
  it('has the sha256 recorded in grammar.lock (catches line-ending corruption)', () => {
    const lock = readToyLock();
    const bytes = fs.readFileSync(path.join(toyDir, lock.wasm.file));
    assert.equal(sha256Hex(bytes), lock.wasm.sha256);
  });

  it('loads in web-tree-sitter as atlas_toy with the locked ABI and parses without errors', async () => {
    const lock = readToyLock();
    await Parser.init();
    const bytes = new Uint8Array(fs.readFileSync(path.join(toyDir, lock.wasm.file)));
    const language = await Language.load(bytes);
    const parser = new Parser();
    try {
      assert.equal(language.abiVersion, lock.abi);
      assert.equal(language.name, 'atlas_toy');
      parser.setLanguage(language);
      const tree = parser.parse('fn a { }');
      assert.ok(tree !== null);
      try {
        assert.equal(tree.rootNode.type, 'source_file');
        assert.equal(hasErrorNode(tree.rootNode), false);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });
});
