import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT_FAILURE, EXIT_LEASE_HELD, EXIT_OK, EXIT_USAGE, exitCodeFor } from './exit.ts';
import type { ExitInput } from './exit.ts';

const failed = (...codes: string[]): ExitInput => ({ ok: false, diagnostics: codes.map((code) => ({ code })) });

describe('exit codes', () => {
  it('are 0 ok, 1 usage, 2 failure and 3 writer lease held or busy', () => {
    assert.equal(EXIT_OK, 0);
    assert.equal(EXIT_USAGE, 1);
    assert.equal(EXIT_FAILURE, 2);
    assert.equal(EXIT_LEASE_HELD, 3);
  });
});

describe('exitCodeFor: one assertion per diagnostic code the Host and Query emit', () => {
  const usage = ['invalid_args', 'module_not_found'];
  const lease = ['lease_held', 'busy'];
  // Everything else the Host, Tenant, Query and the language provider answer with: any other failure is exit 2.
  const failure = [
    'not_indexed',
    'not_a_repo',
    'bad_cursor',
    'output_too_large',
    'unsupported_protocol',
    'unknown_kind',
    'host_closed',
    'timeout',
    'internal_error',
    'store_unavailable',
    'schema_too_new',
    'unknown_worktree',
    'tenant_closed',
    'parse_timeout',
    'parse_failed',
    'golden_mismatch',
    'golden_missing',
    'wasm_hash_mismatch',
    'manifest_invalid',
    'manifest_unreadable',
    'extension_collision',
    'command_denied',
    'spawn_failed',
  ];

  for (const code of usage) {
    it(`${code} gives 1`, () => {
      assert.equal(exitCodeFor(failed(code)), EXIT_USAGE);
    });
  }
  for (const code of lease) {
    it(`${code} gives 3`, () => {
      assert.equal(exitCodeFor(failed(code)), EXIT_LEASE_HELD);
    });
  }
  for (const code of failure) {
    it(`${code} gives 2`, () => {
      assert.equal(exitCodeFor(failed(code)), EXIT_FAILURE);
    });
  }

  it('lease_held and busy give 3 even when the envelope also carries other errors', () => {
    assert.equal(exitCodeFor(failed('not_indexed', 'lease_held')), EXIT_LEASE_HELD);
    assert.equal(exitCodeFor(failed('lease_held', 'store_unavailable')), EXIT_LEASE_HELD);
    assert.equal(exitCodeFor(failed('timeout', 'busy', 'internal_error')), EXIT_LEASE_HELD);
  });

  it('a usage code outranks a lease code, and both outrank any other failure', () => {
    assert.equal(exitCodeFor(failed('busy', 'invalid_args')), EXIT_USAGE);
    assert.equal(exitCodeFor(failed('not_indexed', 'module_not_found', 'lease_held')), EXIT_USAGE);
  });

  it('an ok envelope gives 0 even with warning diagnostics that are not usage or lease codes', () => {
    assert.equal(exitCodeFor({ ok: true, diagnostics: [] }), EXIT_OK);
    assert.equal(exitCodeFor({ ok: true, diagnostics: [{ code: 'manifest_invalid' }, { code: 'fresh_timeout' }, { code: 'user_config_ignored' }] }), EXIT_OK);
  });

  it('a missing diagnostic list gives 2 for a failed envelope and 0 for an ok one', () => {
    assert.equal(exitCodeFor({ ok: false }), EXIT_FAILURE);
    assert.equal(exitCodeFor({ ok: false, diagnostics: [] }), EXIT_FAILURE);
    assert.equal(exitCodeFor({ ok: true }), EXIT_OK);
  });
});
