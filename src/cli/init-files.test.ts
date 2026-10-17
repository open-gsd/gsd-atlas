import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { makeTempDir, realPath } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import { BACKUP_SUFFIX, ConfigChangedError, ConfigInUseError, writeUserFile } from './init-files.ts';

const temps: TempDir[] = [];

afterEach(() => {
  for (const tmp of temps.splice(0)) {
    tmp.cleanup();
  }
});

function makeDir(): string {
  const tmp = makeTempDir();
  temps.push(tmp);
  return realPath(tmp.path);
}

const ORIGINAL = '{"mcpServers":{"other":{"command":"x"}}}\n';
const NEXT = '{"mcpServers":{"other":{"command":"x"},"gsd-atlas":{"command":"n"}}}\n';

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A rename that the operating system refuses, as Node reports it: an Error carrying the errno code. */
function refusing(code: string): (from: string, to: string) => Promise<void> {
  return async () => {
    throw Object.assign(new Error(`${code}: scripted rename failure`), { code });
  };
}

describe('writeUserFile and a rename the operating system refuses (plan 02-45, HST-04)', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`${code} rename: ConfigInUseError, the file keeps its bytes, the backup holds the original, no temp file`, async () => {
      const dir = makeDir();
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, ORIGINAL);

      await assert.rejects(
        writeUserFile(file, NEXT, { bom: false, expected: { digest: digestOf(ORIGINAL) }, renameFile: refusing(code) }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigInUseError, 'a ConfigInUseError');
          assert.equal(error.code, 'config_in_use');
          assert.equal(error.errno, code);
          assert.ok(error.message.includes(file), 'the message names the target');
          return true;
        },
      );

      assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL, 'the config keeps its original bytes');
      assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', `config.json${BACKUP_SUFFIX}`], 'no temp file remains');
      assert.equal(fs.readFileSync(path.join(dir, `config.json${BACKUP_SUFFIX}`), 'utf8'), ORIGINAL);
    });
  }

  it('existing backup untouched: a backup that is already there is neither replaced nor removed', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'config.json');
    const backup = `${file}${BACKUP_SUFFIX}`;
    const older = '{"older":true}\n';
    fs.writeFileSync(file, ORIGINAL);
    fs.writeFileSync(backup, older);

    await assert.rejects(
      writeUserFile(file, NEXT, { bom: false, expected: { digest: digestOf(ORIGINAL) }, renameFile: refusing('EPERM') }),
      ConfigInUseError,
    );

    assert.equal(fs.readFileSync(backup, 'utf8'), older, 'the earlier backup is byte-identical');
    assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', `config.json${BACKUP_SUFFIX}`]);
  });

  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`new file rename refused (${code}): no target, no temp file, no backup`, async () => {
      const dir = makeDir();
      const file = path.join(dir, 'mcp.json');

      await assert.rejects(
        writeUserFile(file, NEXT, { bom: false, expected: { absent: true }, renameFile: refusing(code) }),
        ConfigInUseError,
      );

      assert.ok(!fs.existsSync(file));
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  }

  it('other rename errors keep the generic error: ENOSPC is rethrown as it was and the temp file is removed', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, ORIGINAL);

    await assert.rejects(
      writeUserFile(file, NEXT, { bom: false, expected: { digest: digestOf(ORIGINAL) }, renameFile: refusing('ENOSPC') }),
      (error: unknown) => {
        assert.ok(!(error instanceof ConfigInUseError), 'not classified as in use');
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'ENOSPC');
        return true;
      },
    );

    assert.equal(fs.readFileSync(file, 'utf8'), ORIGINAL);
    assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), 'no temp file remains');
  });

  it('a changed file is still ConfigChangedError, never ConfigInUseError, and the rename is not attempted', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, ORIGINAL);
    let renames = 0;

    await assert.rejects(
      writeUserFile(file, NEXT, {
        bom: false,
        expected: { digest: digestOf(ORIGINAL) },
        afterTemp: (target) => {
          fs.writeFileSync(target, '{"host":"rewrote it"}\n');
        },
        renameFile: async () => {
          renames += 1;
        },
      }),
      ConfigChangedError,
    );

    assert.equal(renames, 0);
  });

  it('without a renameFile the real rename is used and a normal write succeeds', async () => {
    const dir = makeDir();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, ORIGINAL);

    const outcome = await writeUserFile(file, NEXT, { bom: false, expected: { digest: digestOf(ORIGINAL) } });

    assert.equal(outcome.path, file);
    assert.equal(fs.readFileSync(file, 'utf8'), NEXT);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', `config.json${BACKUP_SUFFIX}`]);
  });
});
