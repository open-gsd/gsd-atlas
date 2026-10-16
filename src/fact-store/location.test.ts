/**
 * Where a store lives (STO-07, plan 02-12): the git common directory when it is safe, the cache directory when
 * it is not, and a user-level override that wins. Everything injectable (platform, environment, home, statfs) is
 * injected, so no case reads the real home directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir, realPath } from '../test-kit/index.ts';
import { defaultCacheRoot, isSyncedFolderPath, resolveStoreLocation } from './location.ts';
import type { ResolveStoreLocationInput } from './location.ts';

const STORE_ID = '8d9153397a368aae';
const POSIX = process.platform !== 'win32';
/** Permission bits do not restrict the superuser, so the not-writable case cannot be staged for root. */
const CAN_RESTRICT = POSIX && process.getuid?.() !== 0;

interface World {
  readonly root: string;
  /** `<root>/repo/.git`, created. */
  readonly commonDir: string;
  readonly repoDir: string;
  readonly cacheRoot: string;
  input(extra?: Partial<ResolveStoreLocationInput>): ResolveStoreLocationInput;
}

function withWorld(run: (world: World) => void | Promise<void>): Promise<void> | void {
  const tmp = makeTempDir();
  const root = realPath(tmp.path);
  const repoDir = path.join(root, 'repo');
  const commonDir = path.join(repoDir, '.git');
  fs.mkdirSync(commonDir, { recursive: true });
  const cacheRoot = path.join(root, 'cache');
  const world: World = {
    root,
    commonDir,
    repoDir,
    cacheRoot,
    input: (extra = {}) => ({ storeId: STORE_ID, commonDir, repoDir, cacheRoot, env: {}, ...extra }),
  };
  const done = (): void => {
    tmp.cleanup();
  };
  try {
    const result = run(world);
    if (result instanceof Promise) return result.finally(done);
    done();
    return undefined;
  } catch (error) {
    done();
    throw error;
  }
}

describe('resolveStoreLocation', () => {
  it('uses {commonDir}/gsd-atlas for a writable git common dir, creates it owner-only, and is idempotent', () => {
    withWorld((w) => {
      const first = resolveStoreLocation(w.input());
      assert.deepStrictEqual(first, { dir: path.join(w.commonDir, 'gsd-atlas'), kind: 'git-common' });
      assert.equal(fs.statSync(first.dir).isDirectory(), true);
      if (POSIX) assert.equal(fs.statSync(first.dir).mode & 0o777, 0o700);

      fs.writeFileSync(path.join(first.dir, 'facts.db'), 'existing');
      const second = resolveStoreLocation(w.input());
      assert.deepStrictEqual(second, first, 'idempotent: the same inputs give the same directory');
      assert.equal(fs.readFileSync(path.join(first.dir, 'facts.db'), 'utf8'), 'existing', 'creating a directory that exists changes nothing');
    });
  });

  it('takes a relative common dir (as git prints it) from the checkout directory', () => {
    withWorld((w) => {
      const location = resolveStoreLocation(w.input({ commonDir: '.git' }));
      assert.equal(location.kind, 'git-common');
      assert.equal(location.dir, path.join(w.commonDir, 'gsd-atlas'));
    });
  });

  it('non-git: no common dir puts the store in {cacheRoot}/gsd-atlas/{storeId} with reason not_a_git_repo', () => {
    withWorld((w) => {
      const location = resolveStoreLocation(w.input({ commonDir: null }));
      assert.deepStrictEqual(location, {
        dir: path.join(w.cacheRoot, 'gsd-atlas', STORE_ID),
        kind: 'cache',
        reason: 'not_a_git_repo',
      });
      assert.equal(fs.statSync(location.dir).isDirectory(), true);
      if (POSIX) assert.equal(fs.statSync(location.dir).mode & 0o777, 0o700);
    });
  });

  it('not writable: a common dir that cannot be written to falls back to the cache directory', { skip: !CAN_RESTRICT }, () => {
    withWorld((w) => {
      fs.chmodSync(w.commonDir, 0o500);
      try {
        const location = resolveStoreLocation(w.input());
        assert.deepStrictEqual(location, {
          dir: path.join(w.cacheRoot, 'gsd-atlas', STORE_ID),
          kind: 'cache',
          reason: 'not_writable',
        });
        assert.equal(fs.existsSync(path.join(w.commonDir, 'gsd-atlas')), false, 'nothing was created in the read-only directory');
      } finally {
        fs.chmodSync(w.commonDir, 0o700);
      }
    });
  });

  it('not writable: a regular file where the store directory should be also falls back to the cache directory', () => {
    withWorld((w) => {
      fs.writeFileSync(path.join(w.commonDir, 'gsd-atlas'), 'in the way');
      const location = resolveStoreLocation(w.input());
      assert.equal(location.kind, 'cache');
      assert.equal(location.reason, 'not_writable');
    });
  });

  it('synced folder: a common dir under Dropbox, OneDrive, iCloud Drive or Google Drive moves to the cache directory', () => {
    withWorld((w) => {
      for (const name of ['Dropbox', 'OneDrive - Contoso', 'iCloud Drive', 'Google Drive']) {
        const common = path.join(w.root, name, 'proj', '.git');
        const location = resolveStoreLocation(w.input({ commonDir: common }));
        assert.equal(location.kind, 'cache', name);
        assert.equal(location.reason, 'synced_folder', name);
        assert.equal(location.dir, path.join(w.cacheRoot, 'gsd-atlas', STORE_ID));
        assert.equal(fs.existsSync(path.join(w.root, name)), false, `${name}: nothing is created in the synced folder`);
      }
    });
  });

  it('network mount: a filesystem type that statfs reports as NFS or SMB moves the store to the cache directory', () => {
    withWorld((w) => {
      for (const type of [0x6969, 0x517b, 0xff534d42, 0x65735546, 0x5346414f]) {
        const location = resolveStoreLocation(w.input({ statfs: () => ({ type }) }));
        assert.equal(location.kind, 'cache', `0x${type.toString(16)}`);
        assert.equal(location.reason, 'network_mount');
      }
    });
  });

  it('network mount: an ordinary filesystem type, an undefined answer and a statfs that throws are all ignored', () => {
    withWorld((w) => {
      const ordinary = resolveStoreLocation(w.input({ statfs: () => ({ type: 0xef53 }) }));
      assert.equal(ordinary.kind, 'git-common');
      const unknown = resolveStoreLocation(w.input({ statfs: () => undefined }));
      assert.equal(unknown.kind, 'git-common');
      const broken = resolveStoreLocation(
        w.input({
          statfs: () => {
            throw new Error('statfs is not available here');
          },
        }),
      );
      assert.equal(broken.kind, 'git-common', 'when the check cannot run it is skipped');
    });
  });

  it('symlink: a store directory that is a symbolic link is never followed and the cache directory is used', { skip: !POSIX }, () => {
    withWorld((w) => {
      const target = path.join(w.root, 'elsewhere');
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(w.commonDir, 'gsd-atlas'), 'dir');
      const location = resolveStoreLocation(w.input());
      assert.deepStrictEqual(location, {
        dir: path.join(w.cacheRoot, 'gsd-atlas', STORE_ID),
        kind: 'cache',
        reason: 'store_dir_is_symlink',
      });
      assert.deepStrictEqual(fs.readdirSync(target), [], 'the link target was never written');
    });
  });

  it('override: an absolute store.dir wins over everything and gets the store id appended', () => {
    withWorld((w) => {
      const override = path.join(w.root, 'mine');
      const viaGit = resolveStoreLocation(w.input({ override }));
      assert.deepStrictEqual(viaGit, { dir: path.join(override, STORE_ID), kind: 'override' });
      assert.equal(fs.statSync(viaGit.dir).isDirectory(), true);
      const nonGit = resolveStoreLocation(w.input({ override, commonDir: null }));
      assert.deepStrictEqual(nonGit, viaGit);
      const synced = resolveStoreLocation(w.input({ override, commonDir: path.join(w.root, 'Dropbox', '.git') }));
      assert.deepStrictEqual(synced, viaGit);
      assert.equal(fs.existsSync(path.join(w.commonDir, 'gsd-atlas')), false, 'the git common dir was not used');
    });
  });

  it('override: the environment can supply it when the caller passes none, and the parameter beats the environment', () => {
    withWorld((w) => {
      const fromEnv = path.join(w.root, 'from-env');
      const fromParam = path.join(w.root, 'from-param');
      assert.equal(
        resolveStoreLocation(w.input({ env: { GSD_ATLAS_STORE_DIR: fromEnv } })).dir,
        path.join(fromEnv, STORE_ID),
      );
      assert.equal(
        resolveStoreLocation(w.input({ env: { GSD_ATLAS_STORE_DIR: fromEnv }, override: fromParam })).dir,
        path.join(fromParam, STORE_ID),
      );
    });
  });

  it('override: a relative store.dir is rejected with an error that names the setting', () => {
    withWorld((w) => {
      assert.throws(() => resolveStoreLocation(w.input({ override: 'relative/place' })), /store\.dir.*absolute/);
      assert.throws(
        () => resolveStoreLocation(w.input({ env: { GSD_ATLAS_STORE_DIR: 'relative/place' } })),
        /store\.dir.*absolute/,
      );
    });
  });

  it('override: a store.dir written inside the repository is ignored (repo content cannot place the store)', () => {
    withWorld((w) => {
      const elsewhere = path.join(w.root, 'attacker-chosen');
      fs.writeFileSync(path.join(w.repoDir, 'gsd-atlas.json'), JSON.stringify({ store: { dir: elsewhere } }));
      fs.writeFileSync(path.join(w.commonDir, 'config'), `[gsd-atlas]\n\tdir = ${elsewhere}\n`);
      const location = resolveStoreLocation(w.input());
      assert.equal(location.kind, 'git-common');
      assert.equal(location.dir, path.join(w.commonDir, 'gsd-atlas'));
      assert.equal(fs.existsSync(elsewhere), false);
    });
  });

  it('[edge STO-07/idempotency] resolving the location twice for the same inputs returns the same directory', () => {
    withWorld((w) => {
      const cases: ReadonlyArray<readonly [ResolveStoreLocationInput, string]> = [
        [w.input(), path.join(w.commonDir, 'gsd-atlas')],
        [w.input({ commonDir: null }), path.join(w.cacheRoot, 'gsd-atlas', STORE_ID)],
        [w.input({ override: path.join(w.root, 'o') }), path.join(w.root, 'o', STORE_ID)],
      ];
      for (const [input, expected] of cases) {
        const first = resolveStoreLocation(input);
        assert.equal(first.dir, expected);
        assert.deepStrictEqual(resolveStoreLocation(input), first);
        assert.equal(fs.statSync(expected).isDirectory(), true);
      }
    });
  });

  it('[edge STO-07/concurrency] two simultaneous creations of the same store directory both succeed', async () => {
    await withWorld(async (w) => {
      for (const input of [w.input(), w.input({ commonDir: null })]) {
        const results = await Promise.all([
          Promise.resolve().then(() => resolveStoreLocation(input)),
          new Promise<ReturnType<typeof resolveStoreLocation>>((resolve) => {
            setImmediate(() => {
              resolve(resolveStoreLocation(input));
            });
          }),
        ]);
        assert.deepStrictEqual(results[0], results[1]);
        assert.equal(fs.statSync(results[0].dir).isDirectory(), true);
      }
    });
  });
});

describe('isSyncedFolderPath', () => {
  it('is true for a path segment that names a synced folder, whatever its case', () => {
    for (const p of [
      '/Users/me/Dropbox/work/app/.git',
      '/Users/me/dropbox/app',
      'C:\\Users\\me\\OneDrive\\app',
      'C:\\Users\\me\\OneDrive - Contoso\\app',
      '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/app',
      '/Users/me/iCloud Drive/app',
      '/Users/me/Google Drive/app',
      '/Users/me/GoogleDrive/app',
      '/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/app',
      '/Users/me/Library/CloudStorage/OneDrive-Personal/app',
    ]) {
      assert.equal(isSyncedFolderPath(p, p.includes('\\') ? 'win32' : 'darwin'), true, p);
    }
  });

  it('is false for ordinary paths, including ones that merely contain the word', () => {
    for (const p of [
      '/home/me/projects/app/.git',
      '/Users/me/dev/dropbox-clone/.git',
      '/Users/me/Documents/onedrive-notes.txt',
      'C:\\Users\\me\\src\\app',
      '/srv/git/gsd-atlas',
    ]) {
      assert.equal(isSyncedFolderPath(p, p.includes('\\') ? 'win32' : 'linux'), false, p);
    }
  });

  it('treats a Windows UNC path (two backslashes or two slashes) as a network location', () => {
    assert.equal(isSyncedFolderPath('\\\\server\\share\\repo\\.git', 'win32'), true);
    assert.equal(isSyncedFolderPath('//server/share/repo/.git', 'win32'), true);
    assert.equal(isSyncedFolderPath('//server/share/repo/.git', 'linux'), false, 'on POSIX a leading double slash is just a slash');
    assert.equal(isSyncedFolderPath('C:\\Users\\me\\repo', 'win32'), false);
  });
});

describe('defaultCacheRoot', () => {
  it('uses an absolute XDG_CACHE_HOME, otherwise {home}/.cache', () => {
    const xdg = path.resolve('xdg-cache');
    assert.equal(defaultCacheRoot({ XDG_CACHE_HOME: xdg }, '/home/me'), xdg);
    assert.equal(defaultCacheRoot({}, '/home/me'), path.join('/home/me', '.cache'));
    assert.equal(defaultCacheRoot({ XDG_CACHE_HOME: '' }, '/home/me'), path.join('/home/me', '.cache'));
    assert.equal(defaultCacheRoot({ XDG_CACHE_HOME: 'relative/cache' }, '/home/me'), path.join('/home/me', '.cache'));
  });
});
