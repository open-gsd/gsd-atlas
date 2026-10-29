// Round 3 SDK pack extraction: declarations from the installed MacOSX27.0.sdk.
//   objc  part: Objective-C framework headers (header doc comments + API_AVAILABLE / NS_AVAILABLE_MAC / API_DEPRECATED)
//   swift part: arm64e-apple-macos .swiftinterface files (@available lines; swiftinterfaces carry no prose docs)
// Heuristic, line-oriented parsers (no clang). Output: docs.json in the round 1 schema (slice 'a') plus fw/avail fields.
// usage: node extract-sdk.mjs <sdk-frameworks-dir> <out-dir>
import fs from 'node:fs'; import path from 'node:path';
const [fwDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const splitIdent = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_\-.$:]+/g, ' ').toLowerCase().trim();
const ver = (s) => (s ? s.replace(/_/g, '.') : null);

// ---------- availability ----------
function objcAvail(text) {
  const a = {};
  const m = /\b(?:API_AVAILABLE|API_DEPRECATED|API_DEPRECATED_WITH_REPLACEMENT|API_UNAVAILABLE|NS_AVAILABLE_MAC|NS_DEPRECATED_MAC|NS_AVAILABLE|NS_DEPRECATED|NS_CLASS_AVAILABLE_MAC)\s*\(([^;]*)/.exec(text);
  const macosIntro = /\bmacos\(\s*([0-9._]+)/.exec(text) || /NS_AVAILABLE_MAC\(\s*([0-9._]+)/.exec(text) || /NS_CLASS_AVAILABLE_MAC\(\s*([0-9._]+)/.exec(text) || /\bmacos\s*,\s*introduced\s*=\s*([0-9._]+)/.exec(text) || /macosx\(\s*([0-9._]+)/.exec(text);
  if (macosIntro) a.introduced = ver(macosIntro[1]);
  const dep = /API_DEPRECATED(?:_WITH_REPLACEMENT)?\([^;]*?macos\(\s*[0-9._]+\s*,\s*([0-9._]+)/.exec(text) || /NS_DEPRECATED_MAC\(\s*[0-9._]+\s*,\s*([0-9._]+)/.exec(text);
  if (dep) a.deprecated = ver(dep[1]);
  if (/API_UNAVAILABLE\([^)]*macos/.test(text)) a.unavailable = true;
  return m || macosIntro || dep ? a : null;
}
const availText = (a) => (a ? [a.introduced && `macOS ${a.introduced}+`, a.deprecated && `deprecated macOS ${a.deprecated}`, a.unavailable && 'unavailable on macOS'].filter(Boolean).join(', ') : '');

// ---------- Objective-C headers ----------
function cleanDoc(raw) {
  return raw.replace(/\/\*[*!]?|\*\/|^\s*\*+ ?/gm, ' ').replace(/^\s*\/\/\/? ?/gm, ' ')
    .replace(/@(abstract|discussion|brief|note|param|result|return|constant|textblock|const|warning|see|seealso|code|endcode)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
const SKIP_LINE = /^\s*(#|NS_ASSUME_NONNULL|NS_HEADER_AUDIT|CF_ASSUME_NONNULL|__BEGIN_DECLS|__END_DECLS|NS_SWIFT_UI_ACTOR|NS_REFINED_FOR_SWIFT_)/;
function parseObjC(text, fw, file) {
  const out = []; const lines = text.split('\n');
  let owner = ''; let ownerAvail = null; let pendingDoc = ''; let i = 0;
  const emit = (kind, name, decl, doc, line, av) => {
    if (!name || name.length < 2 || /^(NS|CF|API|CG|CA)_(ASSUME|HEADER|SWIFT|REFINED|SENDABLE|UI)\w*$/.test(name) || /^(NS_ASSUME_NONNULL_(BEGIN|END))$/.test(name)) return;
    const avail = av ?? objcAvail(decl) ?? ownerAvail;
    const sw = /NS_SWIFT_NAME\(\s*([^)]*)\)/.exec(decl);
    out.push({ part: 'objc', fw, file, line, kind, owner, name, swiftName: sw ? sw[1].trim() : '', decl: decl.replace(/\s+/g, ' ').trim(), doc, avail });
  };
  while (i < lines.length) {
    let ln = lines[i];
    // doc comments
    if (/^\s*\/\*[*!]/.test(ln) || /^\s*\/\*\s*$/.test(ln)) {
      let j = i; let buf = ln; while (!buf.includes('*/') && j + 1 < lines.length && j - i < 200) buf += '\n' + lines[++j];
      pendingDoc = cleanDoc(buf); i = j + 1; continue;
    }
    if (/^\s*\/\/\//.test(ln)) { let j = i; let buf = ''; while (j < lines.length && /^\s*\/\/\//.test(lines[j])) buf += lines[j++] + '\n'; pendingDoc = cleanDoc(buf); i = j; continue; }
    if (/^\s*\/\*/.test(ln)) { let j = i; let buf = ln; while (!buf.includes('*/') && j + 1 < lines.length && j - i < 200) buf += '\n' + lines[++j]; i = j + 1; continue; }
    if (/^\s*\/\//.test(ln) || !ln.trim() || SKIP_LINE.test(ln)) { if (!ln.trim()) { /* keep doc across blank */ } i++; continue; }
    const t = ln.trim();
    const take = (endRe, max = 40) => { let j = i; let buf = lines[i]; while (!endRe.test(buf) && j + 1 < lines.length && j - i < max) buf += ' ' + lines[++j].trim(); return [buf, j]; };
    let m;
    if ((m = /^@end\b/.exec(t))) { owner = ''; ownerAvail = null; pendingDoc = ''; i++; continue; }
    if (/^@(class|import)\b/.test(t) || /^@protocol\s+\w+\s*;/.test(t)) { i++; continue; }
    if ((m = /^@(interface|protocol)\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?/.exec(t))) {
      const [buf, j] = take(/[>;]\s*$|\bNS_|\bAPI_|^\s*@/ , 6);
      const name = m[2] + (m[4] ? `(${m[4]})` : ''); const av = objcAvail(buf);
      owner = m[2]; ownerAvail = av; emit(m[1] === 'protocol' ? 'protocol' : (m[4] !== undefined ? 'category' : 'class'), name, buf, pendingDoc, i + 1, av); pendingDoc = ''; i = j + 1; continue;
    }
    if (owner && (t.startsWith('-') || t.startsWith('+')) && /^[-+]\s*\(/.test(t)) {
      const [buf, j] = take(/;\s*$|\{\s*$/);
      const sel = buf.replace(/\([^()]*(\([^()]*\)[^()]*)*\)/g, ' ').replace(/^[-+]\s*/, '');
      const parts = [...sel.matchAll(/([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]);
      const name = parts.length ? parts.join(':') + ':' : (/^\s*([A-Za-z_]\w*)/.exec(sel) || [])[1];
      emit(t.startsWith('+') ? 'classMethod' : 'method', name, buf, pendingDoc, i + 1); pendingDoc = ''; i = j + 1; continue;
    }
    if (owner && t.startsWith('@property')) {
      const [buf, j] = take(/;\s*$/); const mm = /([A-Za-z_]\w*)\s*(?:API_|NS_|__|;|CF_|\[)/.exec(buf.replace(/@property\s*(\([^)]*\))?/, '').replace(/\([^)]*\)\s*$/, ''));
      const nm = /([A-Za-z_]\w*)\s*(?:;|NS_\w+|API_\w+)/.exec(buf.replace(/@property\s*(\([^)]*\))?/, ''));
      emit('property', (nm || mm || [])[1], buf, pendingDoc, i + 1); pendingDoc = ''; i = j + 1; continue;
    }
    if ((m = /^typedef\s+(?:NS_ENUM|NS_OPTIONS|NS_CLOSED_ENUM|NS_ERROR_ENUM|CF_ENUM|CF_OPTIONS|CF_CLOSED_ENUM)\s*\(\s*[^,]+,\s*([A-Za-z_]\w*)/.exec(t))) {
      let j = i; let buf = lines[i]; while (!/^\s*\}\s*(?:[A-Z_]+\([^)]*\)\s*)*;/.test(lines[j]) && j + 1 < lines.length && j - i < 400) buf += ' ' + lines[++j].trim();
      const head = buf.slice(0, 600);
      emit('enum', m[1], head, pendingDoc, i + 1); const enumAv = objcAvail(buf.slice(buf.lastIndexOf('}')));
      // members with own doc or availability
      let cdoc = ''; for (let k = i + 1; k <= j; k++) {
        const L = lines[k]; if (/^\s*\/\*[*!]/.test(L) || /^\s*\/\/\//.test(L)) { let q = k; let b = L; while (!b.includes('*/') && !/^\s*\/\/\//.test(L) && q + 1 <= j) b += '\n' + lines[++q]; cdoc = cleanDoc(b); k = q; continue; }
        const cm = /^\s*([A-Za-z_]\w*)\s*(=|,|API_|NS_|$)/.exec(L); if (cm && !/^\s*\}/.test(L)) { const av = objcAvail(L) ?? enumAv; const prevOwner = owner; owner = m[1]; if (cdoc || av) emit('enumCase', cm[1], L.trim(), cdoc, k + 1, av); owner = prevOwner; cdoc = ''; }
      }
      pendingDoc = ''; i = j + 1; continue;
    }
    if (!owner) {
      // top-level function / constant / typedef: collect to ';'
      if (/^(typedef|extern|static|FOUNDATION_EXPORT|FOUNDATION_EXTERN|APPKIT_EXTERN|[A-Z_]+_EXPORT|[A-Z_]+_EXTERN|CF_EXPORT|CG_EXTERN|CT_EXPORT|[A-Za-z_]+\s+\*?\s*[A-Za-z_]+\s*\()/.test(t) || /^[A-Za-z_][\w\s*]*\(/.test(t)) {
        const [buf, j] = take(/;\s*$|\{\s*$/, 30);
        let name = null;
        if (/^typedef\b/.test(buf)) { const tm = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)/.exec(buf) || /([A-Za-z_]\w*)\s*(?:NS_|API_|CF_|__)?[^A-Za-z_]*;\s*$/.exec(buf); name = tm && tm[1]; }
        else if (buf.includes('(')) { const fm = /([A-Za-z_]\w*)\s*\(/.exec(buf.replace(/\b(?:API|NS|CF|__)\w*\([^)]*\)/g, '')); name = fm && fm[1]; }
        else { const cm = /([A-Za-z_]\w*)\s*(?:API_\w+|NS_\w+|;)/.exec(buf.replace(/const\b/g, '')); name = cm && cm[1]; }
        if (name && !/^(typedef|struct|enum|const|void|static|extern)$/.test(name)) { emit(/^typedef\b/.test(buf) ? 'typedef' : buf.includes('(') ? 'function' : 'constant', name, buf, pendingDoc, i + 1); pendingDoc = ''; }
        i = j + 1; continue;
      }
    }
    // unrecognised line: drop stale doc after a few lines
    if (!/^[{}]/.test(t)) pendingDoc = pendingDoc && /^(@|typedef|NS_|API_)/.test(t) ? pendingDoc : '';
    i++;
  }
  return out;
}

// ---------- Swift interfaces ----------
function swiftAvail(attrs) {
  const a = {};
  for (const at of attrs) {
    let m;
    if ((m = /^@available\(\s*\*\s*,\s*unavailable/.exec(at))) a.unavailable = true;
    if ((m = /(?:macOS|anyAppleOS)\s+([0-9.]+)/.exec(at)) && !/unavailable/.test(at)) a.introduced = a.introduced ?? m[1];
    if ((m = /macOS\s*,\s*introduced:\s*([0-9.]+)/.exec(at))) a.introduced = m[1];
    if ((m = /macOS\s*,\s*deprecated:\s*([0-9.]+)/.exec(at))) a.deprecated = m[1];
    if (/(macOS|macOSApplicationExtension)\s*,\s*unavailable/.test(at) && !/introduced/.test(at)) a.unavailable = true;
  }
  return Object.keys(a).length ? a : null;
}
function parseSwift(text, fw) {
  const out = []; const lines = text.split('\n'); const stack = []; let attrs = [];
  const DECL = /^\s*(?:(?:@[\w_.]+(?:\([^)]*\))?)\s+)*(?:(?:public|open|package|internal|private|fileprivate)\s+)?(?:(?:final|static|class|mutating|nonmutating|nonisolated|convenience|required|override|indirect|dynamic|distributed|prefix|postfix|infix|unowned|weak|lazy|optional|@_Concurrency\.MainActor|@\w+(?:\([^)]*\))?)\s+)*(func|var|let|struct|class|enum|protocol|typealias|init|subscript|case|associatedtype|actor|extension|macro)\b\s*([A-Za-z_][\w.]*|[^\sA-Za-z_(<]{1,3})?/;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]; const t = ln.trim();
    if (!t || t.startsWith('//') || t.startsWith('import ') || t.startsWith('#')) continue;
    if (t.startsWith('}')) { stack.pop(); continue; }
    if (/^@available\(/.test(t) && !DECL.test(t.replace(/^@available\([^)]*\)\s*/, ''))) { attrs.push(t); continue; }
    if (/^@(?!available)[\w_.]+(\([^)]*\))?\s*$/.test(t)) continue;
    const inlineAttrs = [...t.matchAll(/@available\([^)]*\)/g)].map((x) => x[0]);
    const m = DECL.exec(t);
    const opens = /\{\s*$/.test(t);
    if (!m) { if (opens) stack.push({ name: null, avail: stack.at(-1)?.avail ?? null, kind: 'block' }); if (!opens) attrs = attrs; continue; }
    const kind = m[1]; let name = m[2] ?? '';
    const parent = stack.at(-1); const own = swiftAvail([...attrs, ...inlineAttrs]);
    const avail = own ?? parent?.avail ?? null;
    const isPublic = /\b(public|open|package)\b/.test(t) || (parent && ['protocol', 'enum'].includes(parent.kind) && (parent.exported ?? true));
    if (kind === 'extension') {
      const em = /extension\s+([A-Za-z_][\w.<>]*)/.exec(t); if (opens) stack.push({ name: em ? em[1].replace(/<.*/, '') : null, avail, kind: 'extension', exported: true });
      attrs = []; continue;
    }
    if (kind === 'init') name = 'init'; if (kind === 'subscript') name = 'subscript'; if (kind === 'case') name = (/^case\s+([A-Za-z_]\w*)/.exec(t) || [])[1] ?? name;
    if (isPublic && name && !/\bprivate\b|\bfileprivate\b|\binternal\b|@_spi/.test(t)) {
      const owner = stack.filter((s) => s.name).map((s) => s.name).join('.');
      out.push({ part: 'swift', fw, file: '', line: i + 1, kind, owner, name: name.replace(/^.*\./, ''), swiftName: '', decl: t.replace(/\s+/g, ' ').slice(0, 300), doc: '', avail });
    }
    if (opens) stack.push({ name: ['struct', 'class', 'enum', 'protocol', 'actor'].includes(kind) ? name : null, avail, kind, exported: isPublic });
    attrs = [];
  }
  return out;
}

// ---------- drive ----------
const EXCLUDE = new Set(['Kernel', 'DriverKit']); // kernel-space headers are not application SDK surface
const fws = fs.readdirSync(fwDir).filter((n) => n.endsWith('.framework') && !EXCLUDE.has(n.replace(/\.framework$/, ''))).sort();
const rows = []; const seenHeader = new Set(); const stats = { objcFiles: 0, swiftModules: 0, perFw: {} };
for (const f of fws) {
  const fw = f.replace(/\.framework$/, '');
  const hdir = path.join(fwDir, f, 'Headers');
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.h') ? [path.join(d, e.name)] : [])) : []);
  for (const h of walk(fs.existsSync(hdir) ? fs.realpathSync(hdir) : hdir).sort()) {
    const real = fs.realpathSync(h); if (seenHeader.has(real)) continue; seenHeader.add(real); stats.objcFiles++;
    const r = parseObjC(fs.readFileSync(real, 'utf8'), fw, path.basename(real)); rows.push(...r);
  }
  const si = path.join(fwDir, f, 'Modules');
  if (fs.existsSync(si)) for (const m of fs.readdirSync(si).filter((n) => n.endsWith('.swiftmodule'))) {
    const p = path.join(si, m, 'arm64e-apple-macos.swiftinterface');
    if (fs.existsSync(p)) { stats.swiftModules++; rows.push(...parseSwift(fs.readFileSync(p, 'utf8'), fw)); }
  }
}
const docs = []; const ids = new Set();
for (const r of rows) {
  let id = `a:${r.part}:${r.fw}:${r.file}:${r.line}:${r.owner ? r.owner + '.' : ''}${r.name}`; while (ids.has(id)) id += '+'; ids.add(id);
  const owner = r.owner.replace(/::/g, '.').split('.').filter((x, i, a) => !(i === 0 && x === r.fw) && x !== a[i - 1]).join('.');
  const qual = `${r.fw}${owner ? '.' + owner : ''}${r.swiftName ? ' (' + r.swiftName + ')' : ''}`;
  const sig = `${r.kind} ${r.decl.replace(/::/g, '.').slice(0, 200)}${r.avail ? ` ; ${availText(r.avail)}` : ''}`;
  docs.push({ id, slice: 'a', part: r.part, name: r.name, qual, doc: r.doc, sig, nameSplit: splitIdent(`${r.name} ${owner}`), owner, fw: r.fw, kind: r.kind, introduced: r.avail?.introduced ?? null, deprecated: r.avail?.deprecated ?? null, unavailable: !!r.avail?.unavailable });
}
const sdkVersion = process.env.SDK_LABEL ?? path.basename(path.resolve(fwDir, '../..'));
const count = (f) => docs.filter(f).length;
const summary = {
  sdk: sdkVersion, objcFiles: stats.objcFiles, swiftModules: stats.swiftModules, total: docs.length,
  objc: count((d) => d.part === 'objc'), swift: count((d) => d.part === 'swift'),
  objcWithDoc40: count((d) => d.part === 'objc' && d.doc.length >= 40), withIntroduced: count((d) => d.introduced), introduced27: count((d) => d.introduced && d.introduced.startsWith('27')),
  deprecated: count((d) => d.deprecated), kinds: Object.fromEntries(Object.entries(docs.reduce((a, d) => ((a[`${d.part}:${d.kind}`] = (a[`${d.part}:${d.kind}`] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).slice(0, 14)),
};
fs.writeFileSync(path.join(outDir, 'docs.json'), JSON.stringify({ meta: summary, docs }));
console.log(JSON.stringify(summary, null, 1));
