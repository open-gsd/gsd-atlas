// A stand-in for the built `gsd-atlas` binary (dist/bin/gsd-atlas.js) used by the harness tests
// (plan 03-10). It accepts `build` and `maintain`, records its arguments and the environment the
// harness gave it, creates something inside the store directory, and exits.
//
// Environment (all optional):
//   FAKE_ATLAS_RECORD        file that receives one JSON line per invocation
//   FAKE_ATLAS_BUILD_EXIT    exit status of `build` (default 0)
//   FAKE_ATLAS_MAINTAIN_EXIT exit status of `maintain` (default 0)
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const [subcommand, ...rest] = process.argv.slice(2);

if (env.FAKE_ATLAS_RECORD !== undefined) {
  appendFileSync(
    env.FAKE_ATLAS_RECORD,
    `${JSON.stringify({
      subcommand,
      args: rest,
      cwd: process.cwd(),
      store: env.GSD_ATLAS_STORE_DIR ?? null,
      user: env.GSD_ATLAS_USER_DIR ?? null,
    })}\n`,
  );
}
if (subcommand === 'build' && env.GSD_ATLAS_STORE_DIR !== undefined) {
  mkdirSync(join(env.GSD_ATLAS_STORE_DIR, 'fake-store'), { recursive: true });
}
process.stdout.write('{"ok":true}\n');
if (subcommand === 'build') process.exitCode = Number(env.FAKE_ATLAS_BUILD_EXIT ?? 0);
if (subcommand === 'maintain') process.exitCode = Number(env.FAKE_ATLAS_MAINTAIN_EXIT ?? 0);
