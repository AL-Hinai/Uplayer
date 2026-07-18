'use strict';

// Every function named in an inline on*= handler must actually resolve at click time.
//
// public/index.html:94 loads app.js as a CLASSIC script, so every top-level `function` is an
// implicit window global, and 50 inline onclick=/onchange= handlers rely on that. The reliance
// is invisible: nothing imports these names, nothing references them from JS, and a typo or a
// deleted function produces no error until a user clicks the thing. The failure is silent by
// construction.
//
// This is a STATIC test — it reads source text and never opens a browser. It cannot prove a
// handler works; it proves the far cheaper thing that a name resolves to something. That is
// exactly the class of breakage a file split causes.
//
// It exists ahead of the app.js split (docs/ARCHITECTURE.md, phase 4) on purpose. It is written
// against the current single-file app.js as a CONTROL: it passes now, so when it fails during
// the split, the split is what broke it.
//
// Pure: reads files, matches regexes. No DOM, no network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const JS_DIR = path.join(PUBLIC_DIR, 'js');

// Handlers that resolve ONLY via the classic-script implicit-global rule — declared as a
// top-level `function`, never assigned to `window`. They work, but they are the three that
// would break silently under any module conversion, and they document a real fragility.
//
// This list must never GROW. Shrinking it to [] is a goal (assign them in the explicit
// window-export block); adding to it means someone leaned on the accident again.
const KNOWN_IMPLICIT = ['closeModal', 'goBackFromWizard', 'navigate'];

function frontendSources() {
  return fs.readdirSync(JS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: `public/js/${f}`, src: fs.readFileSync(path.join(JS_DIR, f), 'utf8') }));
}

// Names referenced from inline handlers, in app.js's own template strings AND in index.html.
// Covers `onclick="foo("` and `onclick="return foo("`.
function referencedHandlerNames() {
  const sources = frontendSources();
  sources.push({
    file: 'public/index.html',
    src: fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'),
  });

  const names = new Map(); // name -> file it was seen in
  const re = /on(?:click|change|input|submit|keydown)="\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const { file, src } of sources) {
    for (const m of src.matchAll(re)) if (!names.has(m[1])) names.set(m[1], file);
  }
  return names;
}

// Names that will exist on window at click time: either explicitly assigned, or declared as a
// top-level `function` in a classic script (which is the same thing, implicitly).
function definedNames() {
  const explicit = new Set();
  const topLevelFns = new Set();
  for (const { src } of frontendSources()) {
    for (const m of src.matchAll(/^window\.([A-Za-z_$][\w$]*)\s*=/gm)) explicit.add(m[1]);
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) topLevelFns.add(m[1]);
  }
  return { explicit, topLevelFns };
}

function testEveryInlineHandlerResolves() {
  const referenced = referencedHandlerNames();
  const { explicit, topLevelFns } = definedNames();

  const unresolved = [];
  for (const [name, file] of referenced) {
    if (!explicit.has(name) && !topLevelFns.has(name)) unresolved.push(`${name} (used in ${file})`);
  }

  assert.deepStrictEqual(unresolved, [],
    'Inline handlers name functions that resolve to nothing at click time:\n'
    + unresolved.map((u) => `  - ${u}`).join('\n')
    + '\nEither the function was renamed/removed, or it moved to a file that is not loaded '
    + 'before the markup runs.');

  assert.ok(referenced.size > 0, 'sanity: the handler regex should find handlers at all');
}

// The implicit set is a liability, not a feature. Pin it so it can only shrink.
function testImplicitGlobalSetHasNotGrown() {
  const referenced = referencedHandlerNames();
  const { explicit, topLevelFns } = definedNames();

  const implicit = [...referenced.keys()]
    .filter((n) => !explicit.has(n) && topLevelFns.has(n))
    .sort();

  const added = implicit.filter((n) => !KNOWN_IMPLICIT.includes(n));
  assert.deepStrictEqual(added, [],
    `New inline handlers rely on the implicit-global rule: ${added.join(', ')}.\n`
    + 'Assign them to window explicitly instead — see CLAUDE.md, "Frontend".');

  // Shrinking is good, but silently: tell the reader, don't fail them.
  const fixed = KNOWN_IMPLICIT.filter((n) => !implicit.includes(n));
  if (fixed.length) {
    console.log(`  note: ${fixed.join(', ')} no longer implicit — remove from KNOWN_IMPLICIT`);
  }
}

function main() {
  testEveryInlineHandlerResolves();
  testImplicitGlobalSetHasNotGrown();
  console.log('inline-handlers.test.js passed');
}

main();
