import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEGRADED_CODES } from '../src/facts/degraded.ts';
import { MANIFEST_SCHEMA_VERSION } from '../src/lang/manifest.ts';
import { TOOL_NAMES } from '../src/query/tools.ts';

// Validity checks for every skill under skills/ (SKL-01, D-23, D-24). The folder list is read from disk, so a skill
// added later is covered without editing this file. TOOL_NAMES is the single source of truth for the tool names a
// skill may mention (T-03-113), DEGRADED_CODES for the codes, and the header of src/grammar-engine/extract.ts for the
// capture vocabulary, so the skills cannot drift from the code or from plan 03-34's reference docs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'skills');

const DESCRIPTION_MAX = 1536;
const ROUTER = 'gsd-atlas';
const AUTHOR = 'gsd-atlas-module-author';
/** Body limits per skill (D-23: the router is one short page; D-24: the author skill may be longer). */
const BODY_MAX_LINES: Readonly<Record<string, number>> = { [ROUTER]: 80, [AUTHOR]: 200 };
const DEFAULT_BODY_MAX_LINES = 80;
/** The whole file may exceed its body limit by the frontmatter only. */
const FRONTMATTER_ALLOWANCE = 20;

const ROUTER_TOPICS = [
  'file:line',
  'EXTRACTED',
  'INFERRED',
  'edge',
  'watermark',
  'fresh',
  'untrusted_text',
  'code_explain',
  'kind: adr',
] as const;

const AUTHOR_TOPICS = [
  'atlas-lang.json',
  'schemaVersion',
  'tags.scm',
  'refs.scm',
  'imports.scm',
  'grammar.lock',
  'parseBudget',
  'gsd-atlas lang test',
  'golden',
  'modules/typescript',
  'provisional',
] as const;

/** The degraded codes the router must be able to explain (the three added in Phase 3 and the resolver bound). */
const ROUTER_REQUIRED_CODES = ['compiler_fallback', 'memory_budget', 'resolver_timeout'] as const;

/**
 * Snake-case identifiers a skill may put in code ticks besides tool names and degraded codes. Anything else that looks
 * like a code is refused, so a misspelt or invented degraded code cannot hide outside the "Degraded codes" paragraph.
 */
const OTHER_IDENTIFIERS: ReadonlySet<string> = new Set(['untrusted_text', 'not_indexed', 'answer_id', 'text_ref', 'budget_tokens']);

interface Skill {
  readonly folder: string;
  readonly file: string;
  readonly text: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Strips one pair of matching quotes from a single-line YAML scalar. */
function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'");
  }
  return value;
}

/** Parses the leading `---` block as flat `key: value` lines. Anything fancier is refused on purpose. */
function parseSkill(folder: string): Skill {
  const file = path.join(skillsDir, folder, 'SKILL.md');
  assert.ok(existsSync(file), `skills/${folder}/SKILL.md must exist`);
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  assert.equal(lines[0], '---', `skills/${folder}/SKILL.md must start with a --- line`);
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, `skills/${folder}/SKILL.md frontmatter must be closed by a --- line`);
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    assert.ok(match !== null, `skills/${folder}/SKILL.md frontmatter line is not "key: value": ${line}`);
    frontmatter[match[1] as string] = unquote((match[2] as string).trim());
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return { folder, file, text, frontmatter, body };
}

function skillFolders(): string[] {
  assert.ok(existsSync(skillsDir), 'skills/ must exist');
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function allSkills(): Skill[] {
  const folders = skillFolders();
  assert.ok(folders.includes(ROUTER), `skills/${ROUTER}/ must exist`);
  return folders.map(parseSkill);
}

function skillNamed(folder: string): Skill {
  const found = allSkills().find((skill) => skill.folder === folder);
  assert.ok(found !== undefined, `skills/${folder}/ must exist`);
  return found;
}

function bodyLines(skill: Skill): number {
  return skill.body === '' ? 0 : skill.body.split('\n').length;
}

/** The tool-name tokens a text mentions: `code_<word>`, `atlas_status` and `lang_list`. */
function toolTokens(text: string): string[] {
  return [...new Set(text.match(/\b(?:code_[a-z]+|atlas_status|lang_list)\b/g) ?? [])];
}

/** Every code-tick token of a text. */
function tickTokens(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] as string);
}

/**
 * The degraded codes a text names: the code-tick tokens of every "Degraded codes" paragraph (the line that starts with
 * those words, up to the next blank line). Exported to the self-test below so the check is shown to be able to fail.
 */
function degradedMentions(text: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*(?:[-*]\s+)?Degraded codes\b/i.test(lines[index] as string)) continue;
    const paragraph: string[] = [];
    // The paragraph ends at a blank line or at the next list item, so a neighbouring bullet is not read as codes.
    for (let next = index; next < lines.length && (lines[next] as string).trim() !== ''; next += 1) {
      if (next > index && /^\s*[-*]\s/.test(lines[next] as string)) break;
      paragraph.push(lines[next] as string);
    }
    found.push(...tickTokens(paragraph.join('\n')));
  }
  return found;
}

const isDegradedCode = (token: string): boolean => (DEGRADED_CODES as readonly string[]).includes(token);

/** The first doc comment of the extractor: where its capture-name vocabulary is documented (the one place). */
function extractorHeader(): string {
  const source = readFileSync(path.join(root, 'src', 'grammar-engine', 'extract.ts'), 'utf8');
  const end = source.indexOf('*/');
  assert.ok(source.startsWith('/**') && end > 0, 'src/grammar-engine/extract.ts must start with its documented vocabulary');
  return source.slice(0, end);
}

/** Capture families of the vocabulary: `definition.<kind>`, `name`, `export`, `comment`, `import.*`, `reference.*`. */
const CAPTURE_FAMILIES = ['definition', 'name', 'export', 'import', 'reference', 'comment'] as const;

test('name matches folder', () => {
  for (const skill of allSkills()) {
    assert.equal(skill.frontmatter['name'], skill.folder, `skills/${skill.folder}: name must equal the folder name`);
    assert.match(skill.folder, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `skills/${skill.folder}: folder must be lower-case kebab`);
  }
});

test('description length', () => {
  for (const skill of allSkills()) {
    const description = skill.frontmatter['description'];
    assert.ok(description !== undefined && description.trim() !== '', `skills/${skill.folder}: description is required`);
    assert.ok(
      description.length <= DESCRIPTION_MAX,
      `skills/${skill.folder}: description is ${description.length} characters; the limit is ${DESCRIPTION_MAX}`,
    );
  }
});

test('body length', () => {
  for (const skill of allSkills()) {
    const limit = BODY_MAX_LINES[skill.folder] ?? DEFAULT_BODY_MAX_LINES;
    const lines = bodyLines(skill);
    assert.ok(lines > 0, `skills/${skill.folder}: body must not be empty`);
    assert.ok(lines <= limit, `skills/${skill.folder}: body is ${lines} lines; the limit is ${limit}`);
    const fileLines = skill.text.replace(/\n$/, '').split('\n').length;
    assert.ok(
      fileLines <= limit + FRONTMATTER_ALLOWANCE,
      `skills/${skill.folder}: file is ${fileLines} lines; the limit is ${limit + FRONTMATTER_ALLOWANCE}`,
    );
  }
});

test('tool names exist', () => {
  const known = new Set<string>(TOOL_NAMES);
  for (const skill of allSkills()) {
    for (const token of toolTokens(skill.text)) {
      assert.ok(known.has(token), `skills/${skill.folder} names "${token}", which is not in TOOL_NAMES (${TOOL_NAMES.join(', ')})`);
    }
  }
});

test('routes to every code tool', () => {
  const router = skillNamed(ROUTER);
  const mentioned = new Set(toolTokens(router.text));
  for (const tool of TOOL_NAMES) {
    assert.ok(mentioned.has(tool), `skills/${ROUTER} never mentions the tool ${tool}`);
  }
  // The description is the only part always in context, so it must carry the routing itself.
  const description = router.frontmatter['description'] as string;
  assert.ok(
    TOOL_NAMES.filter((tool) => tool.startsWith('code_')).some((tool) => description.includes(tool)),
    `the ${ROUTER} description must name at least one code tool`,
  );
});

test('gsd-atlas limits and topics', () => {
  const router = skillNamed(ROUTER);
  assert.equal(router.frontmatter['name'], ROUTER);
  const description = router.frontmatter['description'] as string;
  assert.ok(description.length <= DESCRIPTION_MAX, `the description is ${description.length} characters`);
  // The description names the trigger situations: what to do before, and the symbol questions it routes.
  assert.match(description, /\bbefore\b/i, 'the description must say when to reach for atlas ("before ...")');
  for (const situation of [/\bdefin/i, /\bcall/i, /\bimpl/i, /\bimpact|break|depend/i, /\bADR\b/]) {
    assert.match(description, situation, `the description must name the situation ${String(situation)}`);
  }
  assert.ok(bodyLines(router) <= (BODY_MAX_LINES[ROUTER] as number), `the body is ${bodyLines(router)} lines`);
  // All seven tools, and no name outside the table (the generic case checks the names; this one the count).
  assert.deepEqual([...toolTokens(router.text)].sort(), [...TOOL_NAMES].sort(), 'the skill must name exactly the seven tools');
  for (const topic of ROUTER_TOPICS) {
    assert.ok(router.body.includes(topic), `skills/${ROUTER} body must cover "${topic}"`);
  }
  // It sends non-symbol text and an already-known file to grep or a plain read.
  assert.match(router.body, /\bgrep\b/, 'the body must name grep as the route for text that is not a symbol');
  assert.match(router.body, /not a symbol/i, 'the body must say text that is not a symbol goes to grep or reading');
  assert.match(router.body, /already know/i, 'the body must say a file already known is read directly');
});

test('degraded codes are real', () => {
  const router = skillNamed(ROUTER);
  const named = degradedMentions(router.body);
  assert.ok(named.length > 0, `skills/${ROUTER} must have a "Degraded codes" paragraph naming the codes it explains`);
  for (const code of named) {
    assert.ok(isDegradedCode(code), `skills/${ROUTER} names the degraded code "${code}", which is not one of the ${DEGRADED_CODES.length}: ${DEGRADED_CODES.join(', ')}`);
  }
  for (const code of ROUTER_REQUIRED_CODES) {
    assert.ok(named.includes(code), `skills/${ROUTER} must explain the degraded code ${code}`);
  }
  // No other snake-case identifier may pose as a code anywhere in the router (a typo outside the paragraph). The
  // author skill is exempt: it names grammar node types such as import_statement, which are not codes.
  const known = new Set<string>([...TOOL_NAMES, ...DEGRADED_CODES, ...OTHER_IDENTIFIERS]);
  for (const token of tickTokens(router.text)) {
    if (!/^[a-z]+(?:_[a-z]+)+$/.test(token)) continue;
    assert.ok(known.has(token), `skills/${ROUTER} puts "${token}" in code ticks; it is not a tool, a degraded code or a listed identifier`);
  }
  for (const code of degradedMentions(skillNamed(AUTHOR).body)) {
    assert.ok(isDegradedCode(code), `skills/${AUTHOR} names the degraded code "${code}", which is not a member of DEGRADED_CODES`);
  }
  // The check can fail: an invented code and a misspelt one are both found.
  const sample = degradedMentions('Intro.\n\n- Degraded codes: `stale`, `bogus_code`, `stalee`.\n  More `fresh_timeout`.\n- Next `fresh`.\n\nOther `memory_budget`.');
  assert.deepEqual(sample, ['stale', 'bogus_code', 'stalee', 'fresh_timeout']);
  assert.deepEqual(sample.filter((code) => !isDegradedCode(code)), ['bogus_code', 'stalee']);
});

test('author skill topics', () => {
  const author = skillNamed(AUTHOR);
  assert.equal(author.frontmatter['name'], AUTHOR);
  assert.ok(bodyLines(author) <= (BODY_MAX_LINES[AUTHOR] as number), `the body is ${bodyLines(author)} lines`);
  for (const topic of AUTHOR_TOPICS) {
    assert.ok(author.body.includes(topic), `skills/${AUTHOR} body must cover "${topic}"`);
  }
  // The manifest version this build writes, and the keys of the worked example, are in the text.
  assert.match(
    author.body,
    new RegExp(`schemaVersion[^\\n]*\\b${String(MANIFEST_SCHEMA_VERSION)}\\b`),
    `skills/${AUTHOR} must state the manifest schemaVersion this build writes (${String(MANIFEST_SCHEMA_VERSION)})`,
  );
  const manifest = JSON.parse(readFileSync(path.join(root, 'modules', 'typescript', 'atlas-lang.json'), 'utf8')) as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    assert.ok(author.body.includes(key), `skills/${AUTHOR} must mention the manifest key "${key}" of the worked example`);
  }
  for (const file of ['tags.scm', 'refs.scm', 'imports.scm']) {
    assert.ok(existsSync(path.join(root, 'modules', 'typescript', 'queries', file)), `the worked example has no queries/${file}`);
  }
  // The precise-tier section exists and says it is provisional (the proof is Phase 9).
  const section = /^#{1,6}\s+[^\n]*precise[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(author.body);
  assert.ok(section !== null, `skills/${AUTHOR} must have a precise-tier section (a heading that names "precise")`);
  assert.match(section[1] as string, /provisional/i, 'the precise-tier section must say it is provisional');
  // The skill is for a person to start: the model does not pick it up on its own.
  assert.equal(author.frontmatter['disable-model-invocation'], 'true', `skills/${AUTHOR} must set disable-model-invocation: true`);
});

test('capture vocabulary covered', () => {
  const header = extractorHeader();
  const author = skillNamed(AUTHOR);
  // Every dotted lower-case token in the header's code ticks is a capture name; its family must be a known one.
  const ticks = tickTokens(header).filter((token) => /^[a-z]+(?:\.[a-z<>-]+)?$/.test(token));
  const documented = new Set<string>();
  for (const token of ticks) {
    const family = token.split('.')[0] as string;
    if (token.includes('.')) {
      assert.ok(
        (CAPTURE_FAMILIES as readonly string[]).includes(family),
        `the extractor documents a capture family "${family}" the author skill test does not know; teach the skill and CAPTURE_FAMILIES`,
      );
    }
    if ((CAPTURE_FAMILIES as readonly string[]).includes(family)) documented.add(token);
  }
  // The header documents every family, so a vanished header cannot make this test pass for nothing.
  for (const family of CAPTURE_FAMILIES) {
    assert.ok([...documented].some((token) => token.split('.')[0] === family), `the extractor header no longer documents "${family}"`);
  }
  for (const family of CAPTURE_FAMILIES) {
    const prefixed = family === 'definition' || family === 'import' || family === 'reference';
    const needle = prefixed ? `${family}.` : family;
    assert.ok(author.body.includes(needle), `skills/${AUTHOR} must name the capture family "${needle}"`);
  }
  // Every concrete capture name (no placeholder) the header lists is named by the skill.
  for (const token of documented) {
    if (token.includes('<') || !token.includes('.')) continue;
    assert.ok(author.body.includes(token), `skills/${AUTHOR} must name the capture "${token}" that the extractor documents`);
  }
});

test('read-only routing: no shell fences, no instruction to trust or run repository text', () => {
  // T-03-111: the skill steers an agent's tool use, so it names read-only atlas tools only.
  for (const skill of allSkills()) {
    assert.ok(!/^```(?:bash|sh|shell|zsh|console)\b/m.test(skill.text), `skills/${skill.folder}: no shell code fences`);
    assert.ok(!/\b(?:sudo|curl|wget|rm -rf|eval)\b/.test(skill.text), `skills/${skill.folder}: no command-running instructions`);
    assert.ok(
      !/\b(?:trust|follow|obey)\b[^.\n]*\b(?:repository|repo|source) (?:text|content|instructions)\b/i.test(skill.text.replace(/(?:never|not|no)\b[^.\n]*/gi, '')),
      `skills/${skill.folder}: must not tell an agent to trust repository text`,
    );
  }
});

test('author skill writes only inside the module folder', () => {
  // D-24: the module author skill never sends an agent outside the module folder or around a hook.
  const author = skillNamed(AUTHOR);
  assert.ok(!/\b(?:--no-verify|--force|git push|npm publish|npm install|npm i)\b/.test(author.text), 'no command that publishes, installs or bypasses a hook');
  assert.ok(!/(?:^|\s)(?:~\/|\/etc\/|\/usr\/|\.\.\/)/m.test(author.body), 'no path outside the module folder');
});
