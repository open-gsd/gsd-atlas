// Validator for corpora/corpora.json, the manifest that pins every eval corpus
// to a commit SHA (FND-08). Built-ins only: the scripts folder uses no Zod.
//
// validateCorpora returns a list of human-readable errors; an empty list means
// the manifest is valid.

const ENTRY_KEYS = new Set(['id', 'repo', 'ref', 'sha', 'status', 'role', 'pinnedAt', 'note']);
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'corpora']);
const STATUSES = new Set(['pinned', 'unselected']);

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A full object id only: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase.
// Never a branch, tag, short SHA or empty string (T-01-11).
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function absent(value: unknown): boolean {
  return value === null || value === undefined;
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function validateEntry(entry: unknown, index: number, seenIds: Set<string>): string[] {
  const errors: string[] = [];
  if (!isRecord(entry)) {
    return [`corpora[${index}]: must be an object`];
  }

  const id = entry['id'];
  const label = typeof id === 'string' && id !== '' ? `corpora[${index}] (${id})` : `corpora[${index}]`;

  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) errors.push(`${label}: unknown key "${key}"`);
  }

  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    errors.push(`${label}: id must match ${ID_PATTERN.source}, got ${describe(id)}`);
  } else if (seenIds.has(id)) {
    errors.push(`${label}: duplicate id "${id}"`);
  } else {
    seenIds.add(id);
  }

  if (!isNonEmptyString(entry['role'])) {
    errors.push(`${label}: role must be a non-empty string`);
  }

  if ('note' in entry && entry['note'] !== undefined && !isNonEmptyString(entry['note'])) {
    errors.push(`${label}: note, when present, must be a non-empty string`);
  }

  const status = entry['status'];
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    errors.push(`${label}: status must be one of pinned, unselected, got ${describe(status)}`);
    return errors;
  }

  if (status === 'pinned') {
    const repo = entry['repo'];
    if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
      errors.push(`${label}: repo must be of the form owner/name, got ${describe(repo)}`);
    }
    if (!isNonEmptyString(entry['ref'])) {
      errors.push(`${label}: ref must be a non-empty string on a pinned entry`);
    }
    const sha = entry['sha'];
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
      errors.push(
        `${label}: sha must be a full lowercase 40-hex (or 64-hex) commit id, not a branch, tag or short sha; got ${describe(sha)}`,
      );
    }
    const pinnedAt = entry['pinnedAt'];
    if (pinnedAt !== undefined && (typeof pinnedAt !== 'string' || !DATE_PATTERN.test(pinnedAt))) {
      errors.push(`${label}: pinnedAt, when present, must be YYYY-MM-DD, got ${describe(pinnedAt)}`);
    }
  } else {
    for (const key of ['repo', 'ref', 'sha', 'pinnedAt'] as const) {
      if (!absent(entry[key])) {
        errors.push(`${label}: an unselected entry must not carry ${key}, got ${describe(entry[key])}`);
      }
    }
  }

  return errors;
}

export function validateCorpora(json: unknown): string[] {
  if (!isRecord(json)) {
    return ['manifest must be a JSON object'];
  }

  const errors: string[] = [];
  for (const key of Object.keys(json)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`manifest: unknown key "${key}"`);
  }

  if (json['schemaVersion'] !== 1) {
    errors.push(`manifest: schemaVersion must be 1, got ${describe(json['schemaVersion'])}`);
  }

  const corpora = json['corpora'];
  if (!Array.isArray(corpora)) {
    errors.push('manifest: corpora must be an array');
    return errors;
  }

  const seenIds = new Set<string>();
  corpora.forEach((entry: unknown, index: number) => {
    errors.push(...validateEntry(entry, index, seenIds));
  });
  return errors;
}
