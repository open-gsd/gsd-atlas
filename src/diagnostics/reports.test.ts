/**
 * Saved reports (docs/DIAGNOSTICS.md section 7): a rendered report kept on this machine under the state directory, listed by
 * `diagnostics history` and deleted by `diagnostics disable`. Local only, mode 0600, never overwritten.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../test-kit/index.ts';
import { REPORTS_MAX, formatSavedReport, listReports, removeState, reportsDir, saveReport } from './reports.ts';

const REPORT = { title: '[diagnostics] atlas 1.2.3', labels: ['diagnostics', 'os:linux'], body: 'Body line\n```diagnostics-v1\n{}\n```\n' };

describe('saved reports', () => {
  it('formats a report as Title, Labels, a blank line and the body', () => {
    assert.equal(formatSavedReport(REPORT), `Title: ${REPORT.title}\nLabels: diagnostics, os:linux\n\n${REPORT.body}`);
  });

  it('saves under <state>/diagnostics/reports/<name>.md with mode 0600 and never overwrites a report', { skip: process.platform === 'win32' }, () => {
    const tmp = makeTempDir();
    try {
      const first = saveReport(tmp.path, '2026-10-18T12-00-00-000Z', REPORT);
      assert.ok(first.ok);
      assert.equal(first.file, path.join(reportsDir(tmp.path), '2026-10-18T12-00-00-000Z.md'));
      assert.equal(fs.readFileSync(first.file, 'utf8'), formatSavedReport(REPORT));
      assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(reportsDir(tmp.path)).mode & 0o777, 0o700);
      const second = saveReport(tmp.path, '2026-10-18T12-00-00-000Z', { ...REPORT, title: 'other' });
      assert.ok(second.ok);
      assert.notEqual(second.file, first.file, 'the same instant gets a second file');
      assert.equal(fs.readFileSync(first.file, 'utf8'), formatSavedReport(REPORT), 'the first report is untouched');
    } finally {
      tmp.cleanup();
    }
  });

  it('a name that could escape the folder is refused', () => {
    const tmp = makeTempDir();
    try {
      for (const name of ['../x', 'a/b', 'a\\b', '', '.hidden', 'x'.repeat(100)]) {
        assert.equal(saveReport(tmp.path, name, REPORT).ok, false, name);
      }
      assert.equal(fs.existsSync(path.join(tmp.path, 'diagnostics')), false, 'nothing was created');
    } finally {
      tmp.cleanup();
    }
  });

  it('lists newest first with the title of each, and skips what is not a saved report', () => {
    const tmp = makeTempDir();
    try {
      saveReport(tmp.path, '2026-10-18T12-00-00-000Z', REPORT);
      saveReport(tmp.path, '2026-10-19T08-30-00-000Z', { ...REPORT, title: '[diagnostics] atlas 1.2.4' });
      fs.writeFileSync(path.join(reportsDir(tmp.path), 'notes.txt'), 'not a report');
      fs.writeFileSync(path.join(reportsDir(tmp.path), 'garbage.md'), 'no title line here');
      const listed = listReports(tmp.path);
      assert.deepEqual(
        listed.map((entry) => [entry.file, entry.title]),
        [
          ['2026-10-19T08-30-00-000Z.md', '[diagnostics] atlas 1.2.4'],
          ['2026-10-18T12-00-00-000Z.md', '[diagnostics] atlas 1.2.3'],
        ],
      );
      assert.ok(listed.every((entry) => entry.bytes > 0));
    } finally {
      tmp.cleanup();
    }
  });

  it('a title with control characters is shown on one line, and a long one is cut', () => {
    const tmp = makeTempDir();
    try {
      saveReport(tmp.path, '2026-10-18T12-00-00-000Z', { ...REPORT, title: `x\u001b[2J${'y'.repeat(1000)}` });
      const [entry] = listReports(tmp.path);
      assert.ok(entry !== undefined);
      assert.ok(!entry.title.includes('\u001b'));
      assert.ok(entry.title.length <= 300);
    } finally {
      tmp.cleanup();
    }
  });

  it('lists nothing when there is no folder, and at most REPORTS_MAX entries', () => {
    const tmp = makeTempDir();
    try {
      assert.deepEqual(listReports(tmp.path), []);
      assert.deepEqual(listReports(path.join(tmp.path, 'missing')), []);
      fs.mkdirSync(reportsDir(tmp.path), { recursive: true });
      for (let i = 0; i < REPORTS_MAX + 5; i += 1) {
        fs.writeFileSync(path.join(reportsDir(tmp.path), `r${String(i).padStart(4, '0')}.md`), `Title: t${String(i)}\n`);
      }
      assert.equal(listReports(tmp.path).length, REPORTS_MAX);
    } finally {
      tmp.cleanup();
    }
  });

  it('removeState deletes the diagnostics folder with every report and says how many; other state files stay', () => {
    const tmp = makeTempDir();
    try {
      saveReport(tmp.path, 'a', REPORT);
      saveReport(tmp.path, 'b', REPORT);
      fs.writeFileSync(path.join(tmp.path, 'other.txt'), 'keep');
      const removed = removeState(tmp.path);
      assert.deepEqual(removed, { reports: 2, folder: true });
      assert.equal(fs.existsSync(path.join(tmp.path, 'diagnostics')), false);
      assert.equal(fs.readFileSync(path.join(tmp.path, 'other.txt'), 'utf8'), 'keep');
      assert.deepEqual(removeState(tmp.path), { reports: 0, folder: false }, 'a second call removes nothing');
    } finally {
      tmp.cleanup();
    }
  });
});
