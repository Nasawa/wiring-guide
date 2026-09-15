#!/usr/bin/env node
/* Regression test for the standalone-export serialization safety fix
 * (index.html's "Download standalone HTML" handler).
 *
 * The exporter interpolates meta.title into <title> and JSON.stringify(spec)
 * into an inline <script>. A spec field containing a script-closing string
 * (`</script>`) could otherwise terminate the script element early, breaking
 * the exported file (or, worse, letting injected markup run). This harness
 * extracts the actual `escapeHtml` / `jsonForInlineScript` helper functions
 * straight out of index.html (via vm, not a reimplementation) and drives them
 * with a crafted — but VALID and renderable — spec, then checks the assembled
 * export is well-formed. It cannot parse HTML or render; the real-browser
 * counterpart (test/browser-smoke.js §7) downloads the actual export and
 * reopens it.
 *
 * Runs two ways:
 *   node test/export-safety.js          — standalone (its own PASS/FAIL + exit code)
 *   require('./export-safety.js').run(report)  — folded into run-validation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadExportHelpers() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const startMarker = 'function escapeHtml(s) {';
  const endMarker = "document.getElementById('dl')";
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate escapeHtml/jsonForInlineScript in index.html — export markup changed?');
  }
  const src = html.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html (extracted)' });
  if (typeof sandbox.escapeHtml !== 'function' || typeof sandbox.jsonForInlineScript !== 'function') {
    throw new Error('extracted snippet did not define escapeHtml/jsonForInlineScript as expected');
  }
  return sandbox;
}

// Builds the same export shape the "dl" click handler builds (title + spec
// serialization), without needing a real DOM/fetch — enough to check that the
// resulting document does not get its <script> terminated early.
function buildExportHtml({ escapeHtml, jsonForInlineScript }, spec, libSrc) {
  const title = (spec.meta && spec.meta.title) || 'Wiring Guide';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>body{margin:0;background:#0d1117;padding:24px;max-width:1500px;margin:0 auto;}</style></head>
<body><div id="app"></div>
<script>${libSrc}<\/script>
<script>renderWiringGuide(${jsonForInlineScript(spec)}, document.getElementById('app'));<\/script>
</body></html>`;
}

// 5 checks: the hostile spec is genuinely renderable (validates clean), then
// four on the assembled export document.
function run(report) {
  const helpers = loadExportHelpers();
  const libSrc = fs.readFileSync(path.join(__dirname, '..', 'wiring.js'), 'utf8');

  const evilTitle = 'Evil</title><script>window.pwned=1;</script><title>Guide';
  const evilNote = 'note with a </script> in it and a <!-- comment too -->';
  // A VALID point-to-point spec (two parts, one wire). Without `mode` this
  // would be a board-mode spec with no pin `loc`s, which the fail-closed
  // validator rejects — the exporter would then be serializing a spec that
  // never renders, and the test would only be exercising JSON.stringify.
  const spec = {
    mode: 'point-to-point',
    meta: { title: evilTitle },
    components: [{ id: 'c', label: 'c', pins: [{ label: 'A' }] }, { id: 'd', label: 'd', pins: [{ label: 'B' }] }],
    nets: [{ id: 'N', from: 'c.A', to: 'd.B', label: evilNote, note: evilNote }],
  };

  // 0. The spec the export path serializes must be one the renderer accepts,
  //    so the checks below are about a real rendered guide. (The real-browser
  //    harness, test/browser-smoke.js §7, renders it, downloads the export,
  //    reopens the file and asserts it draws without running the injected
  //    script; this node-side check keeps `npm test` honest on the same spec.)
  const WG = require(path.join(__dirname, '..', 'wiring.js')).WiringGuide;
  const v = WG.validate(spec);
  report('export: the hostile spec is a VALID, renderable point-to-point spec (validate() returns no errors)',
    v.errors.length === 0, v.errors.length ? v.errors.map(e => String(e).replace(/<[^>]+>/g, '')).join(' | ') : 'clean');

  const html = buildExportHtml(helpers, spec, libSrc);

  // 1. The two <script> blocks we actually opened must be the only ones a naive
  //    HTML parser would close — i.e. the spec's embedded "</script>" text must
  //    not appear literally in the output.
  const rawCloseCount = (html.match(/<\/script>/gi) || []).length;
  report('export: no unescaped </script> from spec data reaches the output',
    rawCloseCount === 2, `found ${rawCloseCount} "</script>" occurrences (expected exactly 2: the library block + the render call)`);

  // 2. The inline JSON still round-trips through JSON.parse to the original spec
  //    (the escaping must be reversible, not lossy).
  // The render-call line is always the export template's last non-empty line
  // before </body></html>; find it that way rather than a global regex, since
  // wiring.js's own source (inlined just above it) may itself contain the
  // substring "renderWiringGuide(" in comments/doc examples.
  const renderCallLine = html.split('\n').reverse().find(l => l.includes(", document.getElementById('app'));"));
  const callMatch = renderCallLine && renderCallLine.match(/^<script>renderWiringGuide\(([\s\S]*), document\.getElementById\('app'\)\);<\/script>$/);
  let roundTrip = null, roundTripError = null;
  try { roundTrip = callMatch && JSON.parse(callMatch[1]); } catch (e) { roundTripError = e; }
  report('export: embedded spec JSON round-trips via JSON.parse to the original spec',
    !roundTripError && roundTrip && roundTrip.meta.title === evilTitle && roundTrip.nets[0].note === evilNote,
    roundTripError ? roundTripError.message : JSON.stringify(roundTrip));

  // 3. The <title> element is HTML-escaped: the malicious title cannot inject a
  //    sibling element or attribute break-out.
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
  const titleInner = titleMatch && titleMatch[1];
  report('export: meta.title is HTML-escaped in <title>',
    !!titleInner && !/<script/i.test(titleInner) && !/<\/title>/i.test(titleInner) && titleInner.indexOf('&lt;') !== -1,
    `<title> contents: ${titleInner}`);

  // 4. The whole exported document must still be well-formed enough that the two
  //    real <script> elements are exactly the ones intended (no third boundary
  //    sneaked in), by counting balanced open/close tags.
  const openCount = (html.match(/<script>/gi) || []).length;
  report('export: <script> open/close tags stay balanced (2 and 2)',
    openCount === 2 && rawCloseCount === 2, `opens=${openCount} closes=${rawCloseCount}`);
}

if (require.main === module) {
  let failures = 0;
  const report = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };
  run(report);
  console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

module.exports = { run };
