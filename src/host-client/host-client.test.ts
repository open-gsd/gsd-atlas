import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGrammarEngine } from '../grammar-engine/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { PROTOCOL_VERSION, createInProcessHostClient } from './index.ts';
import type { Diagnostic, Envelope, HostClient, Request, Roots } from './index.ts';

const TOY = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

describe('HostClient', () => {
  it('a hand-written fake resolves handle() to an Envelope', async () => {
    const seen: Request[] = [];
    const warning: Diagnostic = { code: 'w', severity: 'warning', message: 'careful' };
    const fake: HostClient = {
      async handle(request: Request): Promise<Envelope> {
        seen.push(request);
        return { schema: 'echo.v1', ok: true, data: request.kind, diagnostics: [warning] };
      },
    };

    const reply = await fake.handle({ protocol: PROTOCOL_VERSION, kind: 'ping' });
    assert.equal(reply.ok, true);
    assert.equal(reply.data, 'ping');
    assert.deepEqual(reply.diagnostics, [warning]);
    assert.equal(seen[0]!.protocol, 1);
  });

  it('re-exports PROTOCOL_VERSION as the number 1', () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });
});

describe('createInProcessHostClient', () => {
  const engine = createGrammarEngine();
  const temp = makeTempDir();
  const roots: Roots = {
    repoRoot: path.join(temp.path, 'repo'),
    userDir: path.join(temp.path, 'user'),
    builtinDir: null,
    npmRoots: [],
  };
  const client = createInProcessHostClient({ roots, engine });
  after(async () => {
    await engine.dispose();
    temp.cleanup();
  });

  function basicOnlyModule(): string {
    const dest = path.join(temp.path, 'toy');
    fs.cpSync(TOY, dest, { recursive: true });
    for (const name of ['emoji.toy', 'crlf.toy', 'bom.toy']) {
      fs.rmSync(path.join(dest, 'fixtures', name), { force: true });
      fs.rmSync(path.join(dest, 'fixtures', `${name}.golden.json`), { force: true });
    }
    return dest;
  }

  it('serves lang_test with an ok envelope that carries the report', async () => {
    const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_test', args: { target: basicOnlyModule() } });
    assert.equal(reply.schema, 'gsd-atlas.lang-test/1');
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.diagnostics, []);
    assert.deepEqual(reply.data, { ok: true, module: 'toy', fixtures: [{ file: 'basic.toy', ok: true }], diagnostics: [] });
  });

  it('turns a failing module into a fail envelope with the diagnostics', async () => {
    const reply = await client.handle({
      protocol: PROTOCOL_VERSION,
      kind: 'lang_test',
      args: { target: path.join(temp.path, 'nosuch') },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.data, null);
    assert.deepEqual(
      reply.diagnostics.map((d) => d.code),
      ['module_not_found'],
    );
  });

  it('rejects an unsupported protocol number before looking at the kind', async () => {
    const reply = await client.handle({ protocol: 99, kind: 'lang_test', args: { target: TOY } });
    assert.equal(reply.ok, false);
    assert.deepEqual(
      reply.diagnostics.map((d) => d.code),
      ['unsupported_protocol'],
    );
  });

  it('answers an unknown kind with unknown_kind', async () => {
    const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'frobnicate' });
    assert.equal(reply.ok, false);
    assert.deepEqual(
      reply.diagnostics.map((d) => d.code),
      ['unknown_kind'],
    );
  });

  describe('lang_list and root overrides', () => {
    function rootsWithToy(): Roots {
      const userDir = path.join(temp.path, `user-${String(fs.readdirSync(temp.path).length)}`);
      fs.cpSync(TOY, path.join(userDir, 'languages', 'toy'), { recursive: true });
      return { ...roots, userDir };
    }

    it('serves lang_list from the default roots: an empty list is still an ok envelope', async () => {
      const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list' });
      assert.equal(reply.schema, 'gsd-atlas.lang-list/1');
      assert.equal(reply.ok, true);
      assert.deepEqual(reply.data, { modules: [] });
      assert.deepEqual(reply.diagnostics, []);
    });

    it('serves lang_list with the roots a request overrides', async () => {
      const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list', args: { roots: rootsWithToy() } });
      assert.equal(reply.ok, true);
      const { modules } = reply.data as { modules: Array<{ name: string; source: string; extensions: string[] }> };
      assert.equal(modules.length, 1);
      assert.equal(modules[0]!.name, 'toy');
      assert.equal(modules[0]!.source, 'user');
      assert.deepEqual(modules[0]!.extensions, ['.toy']);
    });

    it('resolves a lang_test id through the roots a request overrides', async () => {
      const reply = await client.handle({
        protocol: PROTOCOL_VERSION,
        kind: 'lang_test',
        args: { target: 'toy', roots: rootsWithToy() },
      });
      assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
      assert.equal((reply.data as { module: string }).module, 'toy');
    });

    it('keeps the default for a root field a request leaves out', async () => {
      const userDir = rootsWithToy().userDir;
      const withUser = createInProcessHostClient({ roots: { ...roots, userDir }, engine });
      const reply = await withUser.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_list', args: { roots: { builtinDir: null } } });
      assert.equal((reply.data as { modules: unknown[] }).modules.length, 1);
    });

    it('answers a malformed or relative roots override with invalid_args', async () => {
      const bad: unknown[] = [
        'x',
        [],
        { repoRoot: 'relative/dir' },
        { userDir: 3 },
        { builtinDir: 'relative' },
        { npmRoots: 'nope' },
        { npmRoots: ['/abs', 'rel'] },
        { surprise: '/abs' },
      ];
      for (const override of bad) {
        for (const kind of ['lang_list', 'lang_test']) {
          const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind, args: { target: 'toy', roots: override } });
          assert.equal(reply.ok, false, JSON.stringify(override));
          assert.deepEqual(
            reply.diagnostics.map((d) => d.code),
            ['invalid_args'],
            JSON.stringify(override),
          );
        }
      }
    });
  });

  it('answers lang_test without a usable target with invalid_args', async () => {
    for (const args of [undefined, {}, { target: 3 }, { target: '' }, null]) {
      const reply = await client.handle({ protocol: PROTOCOL_VERSION, kind: 'lang_test', args });
      assert.equal(reply.ok, false);
      assert.deepEqual(
        reply.diagnostics.map((d) => d.code),
        ['invalid_args'],
      );
    }
  });
});
