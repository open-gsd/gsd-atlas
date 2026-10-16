// Optional online check: confirm every pinned corpus SHA exists upstream.
//
// Usage: node scripts/corpus-check.ts
//
// Needs the GitHub CLI (`gh`) on PATH and authenticated. Read-only: it only calls
// `gh api repos/<repo>/commits/<sha>`. Not part of `npm test` (tests stay offline).
// Exits 1 on any mismatch, missing SHA, invalid manifest or missing `gh`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { validateCorpora } from './corpus.ts';

interface PinnedEntry {
  id: string;
  repo: string;
  sha: string;
}

const manifestUrl = new URL('../corpora/corpora.json', import.meta.url);
const json: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'));

const problems = validateCorpora(json);
if (problems.length > 0) {
  for (const p of problems) console.error(`invalid manifest: ${p}`);
  process.exit(1);
}

const corpora = (json as { corpora: { id: string; repo: string | null; sha: string | null; status: string }[] })
  .corpora;
const pinned = corpora.filter((c): c is PinnedEntry & { status: string } => c.status === 'pinned');

let failures = 0;
for (const { id, repo, sha } of pinned) {
  try {
    // Argument array, no shell: repo and sha come from the validated manifest.
    const resolved = execFileSync('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '.sha'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
    if (resolved === sha) {
      console.log(`OK    ${id} ${repo}@${sha}`);
    } else {
      console.log(`FAIL  ${id} ${repo}@${sha} resolved to ${resolved}`);
      failures += 1;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      console.error('FAIL  the GitHub CLI (gh) was not found on PATH');
      process.exit(1);
    }
    const detail = (err.stderr ?? err.message).toString().trim().split('\n')[0];
    console.log(`FAIL  ${id} ${repo}@${sha} not found upstream: ${detail}`);
    failures += 1;
  }
}

console.log(`${pinned.length - failures}/${pinned.length} pinned corpora confirmed upstream`);
process.exit(failures === 0 ? 0 : 1);
