/**
 * A child process for the stdout guard tests (plan 02-23, research Pitfall 8). It loads the guard, then writes noise
 * to stdout in the two ways a library might, and one protocol frame through the stream the guard hands to the
 * transport. With the guard in place stdout must hold the frame and nothing else, and stderr both noise lines.
 *
 * Modes: `once` loads the guard (the default); `twice` also calls the install function again; `reload` loads a second
 * copy of the guard module, as a bundled or duplicated install would, and writes the frame through that copy.
 * Lives outside `src` so it is neither built nor run as a test.
 */
import process from 'node:process';

import { installStdoutGuard, protocolStdout } from '../../src/mcp-shim/stdout-guard.ts';

const mode = process.argv[2] ?? 'once';
let frameStream = protocolStdout;

if (mode === 'twice') {
  installStdoutGuard();
  installStdoutGuard();
}
if (mode === 'reload') {
  const again = (await import(new URL('../../src/mcp-shim/stdout-guard.ts?again', import.meta.url).href)) as {
    protocolStdout: typeof protocolStdout;
  };
  frameStream = again.protocolStdout;
}

process.stdout.write('noise-direct\n');
// The point of this child: a library calling console.log must not reach stdout.
console.log('noise-console');
frameStream.write('{"jsonrpc":"2.0","method":"frame"}\n');
