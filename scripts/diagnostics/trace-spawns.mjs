/**
 * Opt-in spawn trace (plan 02-46, from .planning/debug/windows-freshness.md): a Node preload that shows where the
 * milliseconds of a save go on an operating system whose process start is slow.
 *
 *   GSD_ATLAS_TRACE_FILE=trace.log node --import ./scripts/diagnostics/trace-spawns.mjs scripts/freshness-gate.ts ...
 *
 * It is active only when it is loaded with `--import` AND `GSD_ATLAS_TRACE_FILE` names a file. Nothing in `src`,
 * `package.json` or a normal gate step loads it. It writes only to that one file, makes no network call and sends
 * nothing anywhere. A failure to write, or to patch anything, never reaches the host program.
 *
 * It records, as lines `<epoch ms> T<thread> <KIND> <detail>`, a closed vocabulary and nothing else:
 *   SPAWN #n <exe> <sub>             a child process was requested: the executable BASE NAME and the git subcommand word
 *   SPAWNED #n +<ms>ms               the child exists (time from the request)
 *   CLOSE #n exit=<code> total=<ms>ms <exe> <sub>
 *   WRITE edit | WRITE add           a file under a `src/gen` directory was written (the gate's fixture), no name
 *   EVENT <types> n=<count>          the first watcher callback's event TYPES and COUNT, no path
 *   SQL <VERB> <ms>ms                a SQLite statement: its first word and duration (COMMIT, BEGIN, or over 0.3 ms)
 * No argument other than the subcommand word, no path, no file content and no statement text is ever logged. It
 * wraps `child_process.spawn`, `fs.writeFileSync`, `@parcel/watcher` `subscribe` and the `node:sqlite` `exec` / `run`
 * methods, and calls the original every time with the original arguments.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';

/** Statements faster than this are not logged (COMMIT and BEGIN always are). */
const SQL_LOG_MIN_MS = 0.3;

const traceFile = process.env.GSD_ATLAS_TRACE_FILE;
if (typeof traceFile === 'string' && traceFile !== '') {
  try {
    install(traceFile);
  } catch {
    // The host program runs exactly as it would without the preload.
  }
}

function install(file) {
  // Creating the file proves it is writable and gives a process that starts no child a valid, empty trace.
  fs.appendFileSync(file, '');
  // On Windows appending nothing to a directory does not throw, so the path must also be a regular file.
  if (!fs.statSync(file).isFile()) throw new Error('not a file');
  const appendFileSync = fs.appendFileSync;
  const now = () => performance.timeOrigin + performance.now();
  const log = (kind, detail) => {
    try {
      appendFileSync(file, `${now().toFixed(2)} T${String(threadId)} ${kind}${detail === '' ? '' : ` ${detail}`}\n`);
    } catch {
      // never into the host
    }
  };
  const ms = (from) => (performance.now() - from).toFixed(1);

  patchSpawn(log, ms);
  patchWrites(log);
  patchWatcher(log);
  patchSqlite(log);
  syncBuiltinESMExports();
}

/** The executable's base name, with no directory. */
const baseName = (file) => String(file).split(/[\\/]/).pop() ?? '';

/**
 * The git subcommand word: the first argument after `-C <dir>`, `-c <key=value>` and `--option` tokens, or `-` when
 * there is none or the executable is not git. This is the only argument that is ever read into a log line.
 */
function subcommandOf(exe, args) {
  if (!/^git(\.exe)?$/i.test(exe)) return '-';
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (typeof a !== 'string') return '-';
    if (a === '-C' || a === '-c') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return /^[a-z][a-z0-9-]*$/i.test(a) ? a : '-';
  }
  return '-';
}

function patchSpawn(log, ms) {
  const originalSpawn = childProcess.spawn;
  let seq = 0;
  childProcess.spawn = function tracedSpawn(file, ...rest) {
    let traced = false;
    let id = 0;
    let label = '';
    const began = performance.now();
    try {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const exe = baseName(file);
      label = `${exe} ${subcommandOf(exe, args)}`;
      seq += 1;
      id = seq;
      traced = true;
      log('SPAWN', `#${String(id)} ${label}`);
    } catch {
      traced = false;
    }
    const child = originalSpawn.call(this, file, ...rest);
    if (traced) {
      try {
        child.once('spawn', () => log('SPAWNED', `#${String(id)} +${ms(began)}ms`));
        child.once('close', (code) => log('CLOSE', `#${String(id)} exit=${String(code)} total=${ms(began)}ms ${label}`));
      } catch {
        // never into the host
      }
    }
    return child;
  };
}

/** `fs.writeFileSync` under a `src/gen` directory: the gate's fixture saves. Whether it was an edit or an add; no name. */
function patchWrites(log) {
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function tracedWriteFileSync(file, ...rest) {
    let kind = null;
    try {
      if (typeof file === 'string' && /[\\/]src[\\/]gen[\\/]/.test(file)) kind = fs.existsSync(file) ? 'edit' : 'add';
    } catch {
      kind = null;
    }
    const result = originalWrite.call(this, file, ...rest);
    if (kind !== null) log('WRITE', kind);
    return result;
  };
}

/** The watcher callback as JavaScript sees it: event types and a count, never a path. */
function patchWatcher(log) {
  let watcher;
  try {
    watcher = createRequire(import.meta.url)('@parcel/watcher');
  } catch {
    return; // not installed here: nothing to trace
  }
  const originalSubscribe = watcher.subscribe;
  if (typeof originalSubscribe !== 'function') return;
  watcher.subscribe = function tracedSubscribe(dir, callback, ...rest) {
    const wrapped = (error, events) => {
      try {
        if (error) {
          log('EVENT', 'error n=0');
        } else {
          const types = [...new Set(events.map((event) => String(event.type)))].sort();
          log('EVENT', `${types.join(',')} n=${String(events.length)}`);
        }
      } catch {
        // never into the host
      }
      return callback(error, events);
    };
    return originalSubscribe.call(this, dir, wrapped, ...rest);
  };
}

/** SQLite statements by VERB and duration. The statement text, its parameters and its results are never read. */
function patchSqlite(log) {
  let sqlite;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite');
  } catch {
    return;
  }
  const verbOf = (sql) => {
    const m = /^\s*([A-Za-z]+)/.exec(String(sql));
    return m === null ? '?' : m[1].toUpperCase();
  };
  const wrap = (proto, name, sqlOf) => {
    const original = proto?.[name];
    if (typeof original !== 'function') return;
    proto[name] = function tracedSql(...args) {
      const began = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        try {
          const elapsed = performance.now() - began;
          const verb = verbOf(sqlOf(this, args));
          if (elapsed >= SQL_LOG_MIN_MS || verb === 'COMMIT' || verb === 'BEGIN') log('SQL', `${verb} ${elapsed.toFixed(2)}ms`);
        } catch {
          // never into the host
        }
      }
    };
  };
  wrap(sqlite.DatabaseSync?.prototype, 'exec', (_self, args) => args[0]);
  wrap(sqlite.StatementSync?.prototype, 'run', (self) => self.sourceSQL);
}
