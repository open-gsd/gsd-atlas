import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES } from '../src/query/tools.ts';

// Validity checks for every skill under skills/ (SKL-01, D-23). The folder list is read from disk, so a skill
// added later (plan 03-33 adds the module-author skill) is covered without editing this file. TOOL_NAMES is the
// single source of truth for the tool names a skill may mention (T-03-113).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'skills');

const DESCRIPTION_MAX = 1536;
const BODY_MAX_LINES = 80;
const FILE_MAX_LINES = 100;
const ROUTER = 'gsd-atlas';
const REQUIRED_TOPICS = ['degraded', 'watermark', 'file:line', 'INFERRED', 'untrusted_text'] as const;

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

/** The tool-name tokens a text mentions: `code_<word>`, `atlas_status` and `lang_list`. */
function toolTokens(text: string): string[] {
  return [...new Set(text.match(/\b(?:code_[a-z]+|atlas_status|lang_list)\b/g) ?? [])];
}

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
    const bodyLines = skill.body === '' ? 0 : skill.body.split('\n').length;
    assert.ok(bodyLines > 0, `skills/${skill.folder}: body must not be empty`);
    assert.ok(bodyLines <= BODY_MAX_LINES, `skills/${skill.folder}: body is ${bodyLines} lines; the limit is ${BODY_MAX_LINES}`);
    const fileLines = skill.text.replace(/\n$/, '').split('\n').length;
    assert.ok(fileLines <= FILE_MAX_LINES, `skills/${skill.folder}: file is ${fileLines} lines; the limit is ${FILE_MAX_LINES}`);
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
  const router = allSkills().find((skill) => skill.folder === ROUTER) as Skill;
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

test('required topics', () => {
  const router = allSkills().find((skill) => skill.folder === ROUTER) as Skill;
  for (const topic of REQUIRED_TOPICS) {
    assert.ok(router.body.includes(topic), `skills/${ROUTER} body must cover "${topic}"`);
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
