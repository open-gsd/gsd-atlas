/**
 * Shared CommandRunner contract suite (D-10, command-runner ADR decision 4).
 *
 * TEST CODE. This file is imported only by this module's own tests, by the relative path
 * `./contract.ts`. It is never re-exported from index.ts and the compiled package does not
 * contain it (plan 01-03 production-purity rule).
 *
 * The suite runs against the recording fake and against the real runner. Every real child is
 * `process.execPath` with an `-e` script, so the scenarios behave the same on every OS and none
 * of them needs npm, npx, a `.cmd` file or a shell.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../test-kit/index.ts';
import type { TempDir } from '../test-kit/index.ts';
import type { CommandResult, CommandRunner, CommandSpec, RunContext } from './index.ts';

/** Everything a scenario may need to build its spec. */
export interface ScenarioEnv {
  /** Fresh temp directory for this scenario; removed after it ran. */
  readonly tmp: string;
  /** The Node executable the real adapter is allowed to start. */
  readonly node: string;
}

/** What the scenario must produce, identically on the fake and the real runner. */
export interface ScenarioExpectation {
  readonly ok: boolean;
  readonly exitCode: number | null;
  /** Exact decoded stdout. */
  readonly stdout: string;
  /** True when the runner must have refused the spec; the denial must name `permissions.commands`. */
  readonly denied: boolean;
}

export interface Scenario {
  readonly name: string;
  build(env: ScenarioEnv): { readonly spec: CommandSpec; readonly ctx?: RunContext };
  readonly expect: ScenarioExpectation;
  /** Extra assertions after the run (for example: the marker file of a denied scenario does not exist). */
  after?(env: ScenarioEnv, result: CommandResult): void;
}

/** Arguments that would be rewritten or executed by any shell. */
export const HOSTILE_ARGS: readonly string[] = [
  'with space',
  'semi;colon',
  '$HOME and $(id)',
  '`id`',
  'say "hi"',
  "it's",
  '*.ts',
  'a|b&c>d',
];

/** Runs a script with `-e`; `--` keeps leading-dash arguments away from node's own option parser. */
const nodeScript = (env: ScenarioEnv, script: string, args: readonly string[] = [], extra: Partial<CommandSpec> = {}): CommandSpec => ({
  executable: env.node,
  args: ['-e', script, '--', ...args],
  ...extra,
});

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'captures stdout and exits 0',
    build: (env) => ({ spec: nodeScript(env, "process.stdout.write('hello')") }),
    expect: { ok: true, exitCode: 0, stdout: 'hello', denied: false },
  },
  {
    name: 'surfaces a non-zero exit code (3) as ok false',
    build: (env) => ({ spec: nodeScript(env, "process.stdout.write('partial'); process.exitCode = 3") }),
    expect: { ok: false, exitCode: 3, stdout: 'partial', denied: false },
  },
  {
    name: 'passes spaces, semicolons, dollars, backticks and quotes to the child unchanged (no shell)',
    build: (env) => ({
      spec: nodeScript(env, 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', HOSTILE_ARGS),
    }),
    expect: { ok: true, exitCode: 0, stdout: JSON.stringify(HOSTILE_ARGS), denied: false },
  },
  {
    name: 'delivers stdin text to the child',
    build: (env) => ({
      spec: nodeScript(
        env,
        "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('got:'+s))",
        [],
        { stdin: 'line one\nline two\n' },
      ),
    }),
    expect: { ok: true, exitCode: 0, stdout: 'got:line one\nline two\n', denied: false },
  },
  {
    name: 'a denied spec starts nothing and carries a diagnostic naming permissions.commands',
    build: (env) => ({
      // The bare name `node` is not process.execPath, so the contract decide refuses it. If it were started it
      // would create the marker file.
      spec: {
        executable: 'node',
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(env.tmp, 'marker'))}, 'started')`],
      },
      ctx: { repo: env.tmp },
    }),
    expect: { ok: false, exitCode: null, stdout: '', denied: true },
    after: (env) => {
      assert.equal(fs.existsSync(path.join(env.tmp, 'marker')), false, 'a denied spec must not start a process');
    },
  },
];

/** Subject under test: the adapter plus the scenarios it was built for (the fake scripts them). */
export type MakeRunner = (scenarios: readonly Scenario[]) => CommandRunner;

/**
 * Registers the contract for one adapter. `make` is called once per scenario, so adapters
 * start each scenario with a clean slate.
 */
export function defineCommandRunnerContract(label: string, make: MakeRunner): void {
  describe(`CommandRunner contract: ${label}`, () => {
    for (const scenario of SCENARIOS) {
      it(scenario.name, async () => {
        const tmp: TempDir = makeTempDir();
        try {
          const env: ScenarioEnv = { tmp: tmp.path, node: process.execPath };
          const runner = make(SCENARIOS);
          const { spec, ctx } = scenario.build(env);
          const result = await runner.run(spec, ctx);
          assert.equal(result.ok, scenario.expect.ok, 'ok');
          assert.equal(result.exitCode, scenario.expect.exitCode, 'exitCode');
          assert.equal(new TextDecoder().decode(result.stdout), scenario.expect.stdout, 'stdout');
          assert.equal(result.denied !== undefined, scenario.expect.denied, 'denied');
          if (scenario.expect.denied) {
            assert.equal(result.denied?.code, 'command_denied');
            assert.ok(result.denied?.message.includes('permissions.commands'), 'denial names the config key');
            assert.equal(result.spawnError, undefined, 'a denial is not a spawn error');
          }
          scenario.after?.(env, result);
        } finally {
          tmp.cleanup();
        }
      });
    }
  });
}
