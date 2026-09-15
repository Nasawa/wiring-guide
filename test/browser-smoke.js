#!/usr/bin/env node
/* Real-browser smoke test for the parts FakeDOM cannot see: layout, computed
 * colors, contrast, ARIA validity, real HTML parsing, real downloads.
 * Complements run-validation.js/render.js, which are structure-only.
 *
 *   node test/browser-smoke.js            — needs `playwright` (Chromium)
 *   node test/browser-smoke.js --verbose  — also print per-rule axe detail
 *
 * Optional deps, resolved locally or from the global npm root:
 *   playwright  — REQUIRED for the run; if missing the script prints SKIP and
 *                 exits 0 (so `npm test` stays dependency-free). Set
 *                 BROWSER_SMOKE_REQUIRED=1 to make a missing browser a failure.
 *   axe-core    — optional; when present, WCAG 2.x A/AA checks run too. Under
 *                 BROWSER_SMOKE_REQUIRED=1 a missing axe-core is a FAILURE (the
 *                 WCAG numbers are part of the enforced contract).
 *
 * What it asserts:
 *   1. README minimal embed on a plain WHITE host page, BOTH themes: the .wg
 *      root paints its own background and ordinary text (headings, table
 *      cells, muted text, inline net references) reaches WCAG AA 4.5:1.
 *   2. Playground at 390×844: the JSON editor has real height and the page
 *      does not scroll horizontally (toolbar wraps).
 *   3. Playground desktop, both themes: axe reports zero color-contrast and
 *      zero aria-allowed-attr violations (when axe-core is available); no
 *      404s while loading the playground (favicon included); ARIA only on
 *      real buttons.
 *   4. Adversarial author hex colors as inline reference TEXT stay opaque and
 *      ≥ 4.5:1 in both themes while the drawing strokes keep the author color.
 *   5. Cross-control pin state: row button ↔ build-step button stay in sync.
 *   6. Theme is honored on the validation-failure path.
 *   7. Real HTML PARSING of index.html: the JSON editor actually populates
 *      from the auto-loaded demo, the preview actually renders, and the
 *      "Download standalone HTML" handler produces a well-formed, parseable
 *      export even for a VALID, RENDERED spec whose title/fields contain a
 *      script-closing string. The downloaded file is then reopened from
 *      file:// and must render its guide without executing the injected
 *      script. This is the check the FakeDOM/vm-based unit tests cannot do —
 *      a stray literal script-closing (or comment-opening) sequence inside
 *      index.html's own inline script silently truncates the whole script at
 *      parse time with no JS exception, which a vm-extracted-source test
 *      never sees. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

function tryRequire(name) {
  try { return require(name); } catch (_) { /* fall through */ }
  try {
    const g = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return require(path.join(g, name));
  } catch (_) { return null; }
}
function tryResolveFile(name) {
  for (const base of [null, (() => { try { return execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return null; } })()]) {
    try { return base ? require.resolve(path.join(base, name)) : require.resolve(name); } catch (_) { /* next */ }
  }
  return null;
}

const playwright = tryRequire('playwright');
if (!playwright) {
  const msg = 'browser-smoke: `playwright` not installed (npm i -D playwright && npx playwright install chromium)';
  if (process.env.BROWSER_SMOKE_REQUIRED) { console.error('FAIL  ' + msg + ' — BROWSER_SMOKE_REQUIRED is set'); process.exit(1); }
  console.log('SKIP  ' + msg); process.exit(0);
}
const axePath = tryResolveFile('axe-core/axe.min.js');
const axeSrc = axePath ? fs.readFileSync(axePath, 'utf8') : null;
if (!axeSrc && process.env.BROWSER_SMOKE_REQUIRED) {
  // In enforced mode the WCAG numbers are part of the contract: a vanished
  // axe-core must fail the run, not silently drop the rule checks.
  console.error('FAIL  browser-smoke: `axe-core` not installed and BROWSER_SMOKE_REQUIRED is set (npm i -D axe-core)');
  process.exit(1);
}

let failures = 0, checks = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  checks++;
  if (!ok) failures++;
};

// ---- tiny static server (zero deps) + a synthetic white-host embed page ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.md': 'text/plain' };
// The README's minimal embed, verbatim in spirit: a host page that styles NOTHING.
const embedPage = theme => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>embed ${theme}</title></head>
<body><h1 id="host">Host page</h1><div id="app"></div>
<script src="/wiring.js"></script>
<script>fetch('/specs/demo-divider-adc.json').then(r => r.json())
  .then(s => { renderWiringGuide(s, document.getElementById('app')${theme === 'light' ? ", { theme: 'light' }" : ''}); document.body.dataset.ready = '1'; });</script>
</body></html>`;

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/__embed.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(embedPage(url.searchParams.get('theme') === 'light' ? 'light' : 'dark'));
      }
      if (url.pathname === '/__blank.html') { // unstyled host + library loaded, nothing rendered yet
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>blank host</title></head><body><div id="app"></div><script src="/wiring.js"></script></body></html>');
      }
      let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
      if (url.pathname === '/') p = path.join(ROOT, 'index.html');
      fs.readFile(p, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---- in-page helpers (serialized into the browser) ----
const PAGE_HELPERS = `
  const parseRGB = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null;
    const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  // effective painted background behind an element: nearest ancestor with an
  // opaque background, else the canvas (white in a plain host page).
  const bgBehind = e => { for (let n = e; n; n = n.parentElement) { const c = parseRGB(getComputedStyle(n).backgroundColor);
    if (c && c.a >= 0.99) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const textContrast = e => ratio(parseRGB(getComputedStyle(e).color), bgBehind(e));
`;

async function runAxe(page) {
  if (!axeSrc) return null;
  await page.addScriptTag({ content: axeSrc });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    const byRule = {};
    r.violations.forEach(v => { byRule[v.id] = { impact: v.impact, nodes: v.nodes.length, sample: v.nodes.slice(0, 4).map(n => n.target.join(' ') + ' :: ' + (n.any[0] && n.any[0].message || '')) }; });
    return byRule;
  });
}
const axeCount = (byRule, id) => (byRule && byRule[id]) ? byRule[id].nodes : 0;
function printAxe(label, byRule) {
  if (!byRule) return;
  const total = Object.values(byRule).reduce((n, v) => n + v.nodes, 0);
  console.log(`      axe[${label}]: ${total} violating node(s) — ` + (Object.keys(byRule).map(k => `${k}=${byRule[k].nodes}`).join(', ') || 'none'));
  if (VERBOSE) Object.keys(byRule).forEach(k => byRule[k].sample.forEach(s => console.log(`        ${k}: ${s}`)));
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await playwright.chromium.launch();
  try {
    // ==== 1. minimal embed on a white host page, both themes ====
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${base}/__embed.html?theme=${theme}`);
      await page.waitForSelector('body[data-ready="1"]');
      const m = await page.evaluate(`(() => { ${PAGE_HELPERS}
        const wg = document.querySelector('.wg');
        const bg = parseRGB(getComputedStyle(wg).backgroundColor);
        const pick = sel => Array.from(wg.querySelectorAll(sel)).filter(e => (e.textContent || '').trim());
        const samples = [].concat(pick('h1'), pick('h2'), pick('td'), pick('.sub'), pick('.hint'), pick('summary'), pick('.step'), pick('.wref'));
        const worst = samples.reduce((w, e) => { const c = textContrast(e); return c < w.c ? { c, tag: e.tagName + '.' + e.className, color: getComputedStyle(e).color } : w; }, { c: 99 });
        return { paints: !!bg && bg.a >= 0.99, bg: getComputedStyle(wg).backgroundColor, samples: samples.length, worst,
          wrefBelowAA: pick('.wref').filter(e => textContrast(e) < 4.5).length, wrefTotal: pick('.wref').length };
      })()`);
      report(`embed(${theme}) on white host: .wg paints its own background`, m.paints, `background=${m.bg}`);
      report(`embed(${theme}) on white host: all sampled text ≥ 4.5:1 (${m.samples} samples)`, m.worst.c >= 4.5,
        `worst ${m.worst.c.toFixed(2)}:1 at ${m.worst.tag} color=${m.worst.color}`);
      report(`embed(${theme}) on white host: inline net references (.wref) ≥ 4.5:1`, m.wrefBelowAA === 0, `${m.wrefBelowAA}/${m.wrefTotal} below AA`);
      const axe = await runAxe(page);
      if (axe) {
        printAxe(`embed ${theme}`, axe);
        report(`embed(${theme}) on white host: axe color-contrast violations = 0`, axeCount(axe, 'color-contrast') === 0, `${axeCount(axe, 'color-contrast')}`);
      }
      await page.close();
    }

    // ==== 2. playground at a phone viewport ====
    {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`${base}/`);
      // 'attached', not 'visible': on a broken layout the table may have zero
      // height, and that is exactly what the measurements below must report.
      await page.waitForSelector('#preview.wg table', { state: 'attached' });
      const m = await page.evaluate(() => {
        const sw = document.querySelector('.spec-wrap').getBoundingClientRect();
        const header = document.querySelector('header').getBoundingClientRect();
        const btns = Array.from(document.querySelectorAll('header button')).map(b => b.getBoundingClientRect().right);
        return { specH: sw.height, specW: sw.width, docW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth,
          headerH: header.height, maxBtnRight: Math.max(...btns), vw: window.innerWidth,
          editorVisible: !!document.querySelector('#spec') && document.querySelector('#spec').getBoundingClientRect().height > 0 };
      });
      report('playground@390×844: JSON editor (.spec-wrap) has real height (≥ 160px)', m.specH >= 160, `${m.specW}×${Math.round(m.specH)}px, header ${Math.round(m.headerH)}px`);
      report('playground@390×844: no horizontal document overflow', m.docW <= m.vw && m.bodyW <= m.vw, `scrollWidth=${m.docW} viewport=${m.vw}`);
      report('playground@390×844: toolbar buttons stay inside the viewport', m.maxBtnRight <= m.vw, `rightmost button edge ${Math.round(m.maxBtnRight)}px`);
      report('playground@390×844: textarea is laid out', m.editorVisible);
      await page.close();
    }

    // ==== 3. playground desktop, both themes: axe + no 404 ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const bad = [];
      page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
      await page.goto(`${base}/`);
      await page.waitForSelector('#preview.wg table');
      await page.waitForTimeout(300);
      report('playground: no failed resource requests (favicon included)', bad.length === 0, bad.join(', ') || 'clean');
      const hasIcon = await page.evaluate(() => !!document.querySelector('link[rel~="icon"]'));
      report('playground: declares a favicon <link rel="icon">', hasIcon);
      const rowSem = await page.evaluate(() => {
        const bad = Array.from(document.querySelectorAll('.wg [aria-pressed], .wg [tabindex="0"]'))
          .filter(e => !(e.tagName === 'BUTTON' || e.tagName === 'SVG' || e.tagName === 'svg' || e.getAttribute('role') === 'button'));
        return { bad: bad.length, buttons: document.querySelectorAll('.wg button[aria-pressed]').length };
      });
      report('playground: aria-pressed/tabindex only on buttons (or role=button) — table rows keep table semantics', rowSem.bad === 0,
        `${rowSem.bad} raw element(s) with aria-pressed/tabindex; ${rowSem.buttons} real toggle buttons`);
      const axeDark = await runAxe(page);
      if (axeDark) {
        printAxe('playground dark', axeDark);
        report('playground(dark): axe color-contrast = 0', axeCount(axeDark, 'color-contrast') === 0, `${axeCount(axeDark, 'color-contrast')}`);
        report('playground(dark): axe aria-allowed-attr = 0', axeCount(axeDark, 'aria-allowed-attr') === 0, `${axeCount(axeDark, 'aria-allowed-attr')}`);
      }
      await page.evaluate(() => renderWiringGuide(JSON.parse(document.getElementById('spec').value), document.getElementById('preview'), { theme: 'light' }));
      const axeLight = await runAxe(page);
      if (axeLight) {
        printAxe('playground light', axeLight);
        report('playground(light): axe color-contrast = 0', axeCount(axeLight, 'color-contrast') === 0, `${axeCount(axeLight, 'color-contrast')}`);
        report('playground(light): axe aria-allowed-attr = 0', axeCount(axeLight, 'aria-allowed-attr') === 0, `${axeCount(axeLight, 'aria-allowed-attr')}`);
      }
      if (!axeSrc) console.log('      (axe-core not installed — WCAG rule checks skipped; npm i -D axe-core to enable)');
      await page.close();
    }

    // ==== 4. adversarial author hex colors as inline reference TEXT ====
    // 3/4/6/8-digit, alpha forms (must come back opaque), the two 4.48:1
    // post-rounding near-misses, both extremes. Measured on the rendered
    // <button class="wref"> in both themes, then axe over the same mount.
    {
      const hexes = ['#112', '#9e7', '#00000000', '#ffffff80', '#0000', '#f0f8', '#b45309', '#123456', '#FFF', '#000000ff'];
      for (const theme of ['dark', 'light']) {
        // Own blank host page + tall viewport: nothing else on the page and no
        // scrolling, so axe measures the reference text itself rather than a
        // sticky board that happens to overlap it mid-scroll.
        const page = await browser.newPage({ viewport: { width: 1200, height: 2400 } });
        await page.goto(`${base}/__blank.html`);
        await page.waitForFunction(() => typeof window.renderWiringGuide === 'function');
        const m = await page.evaluate(`((hexes, theme) => { ${PAGE_HELPERS}
          const nets = hexes.map((c, i) => ({ id: 'H' + i, color: c, from: [1, i + 1], to: [3, i + 1] }));
          const spec = { meta: { title: 'hex', buildOrder: ['Refs: ' + nets.map(n => n.id).join(', ')] },
            board: { preset: 'perf', cols: 6, rows: 12 }, components: [], nets };
          const mount = document.getElementById('app');
          renderWiringGuide(spec, mount, { theme });
          const refs = Array.from(mount.querySelectorAll('button.wref')).map((b, i) => {
            const c = parseRGB(getComputedStyle(b).color);
            return { hex: hexes[i], css: b.style.color, opaque: !!c && c.a >= 0.99, contrast: textContrast(b) };
          });
          const strokes = Array.from(mount.querySelectorAll('.wire')).map(w => w.style.stroke);
          return { refs, strokes };
        })(${JSON.stringify(hexes)}, ${JSON.stringify(theme)})`);
        const below = m.refs.filter(r => !r.opaque || r.contrast < 4.5);
        report(`adversarial hex(${theme}): all ${m.refs.length} inline refs opaque and ≥ 4.5:1 on the panel`, m.refs.length === hexes.length && below.length === 0,
          below.length ? below.map(r => `${r.hex}→${r.css} ${r.contrast.toFixed(2)}:1${r.opaque ? '' : ' NOT OPAQUE'}`).join('; ')
                       : m.refs.map(r => `${r.hex}→${r.css} ${r.contrast.toFixed(2)}`).join(' '));
        report(`adversarial hex(${theme}): drawing strokes keep the author's color (text palette is separate)`,
          m.strokes.length === hexes.length && m.strokes.every(Boolean), m.strokes.slice(0, 3).join(' '));
        const axe = await runAxe(page);
        if (axe) {
          printAxe(`adversarial hex ${theme}`, axe);
          report(`adversarial hex(${theme}): axe color-contrast = 0 on the page`, axeCount(axe, 'color-contrast') === 0, `${axeCount(axe, 'color-contrast')}`);
        }
        await page.close();
      }
    }

    // ==== 5. cross-control pin state: row button ↔ build-step button ====
    // The same net has several controls; pinned/aria-pressed/highlight must
    // stay consistent across ALL of them, and a hover-leave on an unpinned
    // control of a pinned net (or of another net) must not clear the highlight.
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(`${base}/`);
      await page.waitForSelector('#preview.wg table');
      const id = await page.evaluate(() => document.querySelector('button.wref').dataset.ref);
      const state = () => page.evaluate(id => {
        const tr = document.querySelector(`tr.wrow[data-net="${id}"]`);
        const refs = Array.from(document.querySelectorAll(`button.wref[data-ref="${id}"]`));
        return { rowPinned: tr.classList.contains('pinned'), rowPressed: tr.querySelector('button.rowbtn').getAttribute('aria-pressed'),
          refPressed: refs.map(r => r.getAttribute('aria-pressed')).join(','), refPinned: refs.every(r => r.classList.contains('pinned')),
          hl: document.querySelectorAll(`#preview svg [data-id="${id}"].hl`).length, hits: document.querySelectorAll(`#preview svg [data-id="${id}"]`).length };
      }, id);
      const rowSel = `tr.wrow[data-net="${id}"]`, refSel = `button.wref[data-ref="${id}"]`;
      await page.click(`${rowSel} td:nth-child(2)`);
      let s = await state();
      report(`cross-control(${id}): pin from the row → row + every build-step ref pressed, highlight on`,
        s.rowPinned && s.rowPressed === 'true' && !/false/.test(s.refPressed) && s.refPinned && s.hl === s.hits && s.hits > 0, JSON.stringify(s));
      await page.click(refSel);                       // unpin from the build-step button
      s = await state();
      report(`cross-control(${id}): unpin from a build-step ref → row unpressed too, highlight off`,
        !s.rowPinned && s.rowPressed === 'false' && !/true/.test(s.refPressed) && s.hl === 0, JSON.stringify(s));
      await page.click(refSel);                       // re-pin from the build-step button
      s = await state();
      report(`cross-control(${id}): re-pin from the build-step ref → row pressed again`,
        s.rowPinned && s.rowPressed === 'true' && s.hl === s.hits, JSON.stringify(s));
      await page.hover(rowSel); await page.mouse.move(5, 5); // hover-leave the ROW while pinned via the ref
      s = await state();
      report(`cross-control(${id}): hover-leave on another control of the pinned net keeps the highlight`, s.hl === s.hits, JSON.stringify(s));
      const otherRow = await page.evaluate(id => document.querySelector(`tr.wrow:not([data-net="${id}"])`).dataset.net, id);
      await page.hover(`tr.wrow[data-net="${otherRow}"]`); await page.mouse.move(5, 5); // hover-leave a DIFFERENT, unpinned net
      s = await state();
      report(`cross-control(${id}): hover-leave on an unpinned OTHER net (${otherRow}) does not clear the pinned highlight`, s.hl === s.hits, JSON.stringify(s));
      await page.focus(`${rowSel} button.rowbtn`); await page.keyboard.press('Enter'); // keyboard unpin from the row button
      s = await state();
      report(`cross-control(${id}): Enter on the row button unpins everything once`, !s.rowPinned && !/true/.test(s.refPressed), JSON.stringify(s));
      await page.close();
    }

    // ==== 6. theme honored on the validation-failure path ====
    {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      await page.goto(`${base}/`);
      await page.waitForSelector('#preview.wg table');
      const m = await page.evaluate(async () => {
        const bad = await (await fetch('specs/demo-pin15-vcc-wrong.json')).json();
        const good = await (await fetch('specs/demo-pin17-vcc-correct.json')).json();
        const quiet = fn => { const e = console.error; console.error = () => {}; try { fn(); } catch (err) { return err && err.name; } finally { console.error = e; } };
        const a = document.createElement('div'); document.body.appendChild(a);
        const errA = quiet(() => renderWiringGuide(bad, a, { theme: 'light' }));
        const fresh = { err: errA, light: a.classList.contains('wg-light'), bg: getComputedStyle(a).backgroundColor, box: !!a.querySelector('.warn') };
        const b = document.createElement('div'); document.body.appendChild(b);
        renderWiringGuide(good, b, { theme: 'light' });
        const wasLight = b.classList.contains('wg-light');
        const errB = quiet(() => renderWiringGuide(bad, b, { theme: 'dark' }));
        const stale = { wasLight, err: errB, light: b.classList.contains('wg-light'), bg: getComputedStyle(b).backgroundColor };
        a.remove(); b.remove();
        return { fresh, stale };
      });
      report('theme-on-error: fresh invalid render with {theme:"light"} paints the light error box',
        m.fresh.err === 'WiringValidationError' && m.fresh.light && m.fresh.bg === 'rgb(255, 255, 255)' && m.fresh.box, JSON.stringify(m.fresh));
      report('theme-on-error: a mount that rendered light, then fails asking for dark, drops .wg-light and paints dark',
        m.stale.wasLight && m.stale.err === 'WiringValidationError' && !m.stale.light && m.stale.bg === 'rgb(13, 17, 23)', JSON.stringify(m.stale));
      await page.close();
    }

    // ==== 7. real HTML parsing: playground loads via the actual <script> tags
    // (no vm/source-extraction), the editor populates, and standalone export
    // survives a script-closing string in spec data. 11 checks: 3 boot,
    // 1 hostile-spec-renders, 4 on the downloaded bytes, 3 on reopening the
    // downloaded file from file:// ====
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
      await page.goto(`${base}/`);
      await page.waitForSelector('#preview.wg table');
      const boot = await page.evaluate(() => ({
        specLen: document.getElementById('spec').value.length,
        previewChildren: document.getElementById('preview').children.length,
        hasDownloadFns: typeof window.escapeHtml === 'function' && typeof window.jsonForInlineScript === 'function',
        dlWired: !!document.getElementById('dl'),
      }));
      report('playground: JSON editor auto-populates from the initial demo (not truncated by a stray script-closing sequence in inline JS)',
        boot.specLen > 0, `#spec value length = ${boot.specLen}`);
      report('playground: preview actually rendered (has child nodes)', boot.previewChildren > 0, `${boot.previewChildren} child node(s)`);
      report('playground: export helper functions (escapeHtml/jsonForInlineScript) are defined',
        boot.hasDownloadFns, `escapeHtml/jsonForInlineScript present = ${boot.hasDownloadFns}`);

      // Load a VALID point-to-point spec whose title and a field contain a
      // script-closing string, confirm it actually RENDERS (so the export
      // path below serializes a real guide, not a validation-failure box),
      // then drive the real "Download standalone HTML" button and inspect
      // the actual downloaded file (not a re-implementation of the export).
      const evilTitle = "Evil</title><script>window.pwned=1;</script><title>Guide";
      const evilNote = "note with a </script> in it and a <!-- comment too -->";
      const rendered = await page.evaluate(({ evilTitle, evilNote }) => {
        const spec = {
          mode: 'point-to-point',
          meta: { title: evilTitle },
          components: [{ id: 'c', label: 'c', pins: [{ label: 'A' }] }, { id: 'd', label: 'd', pins: [{ label: 'B' }] }],
          nets: [{ id: 'N', from: 'c.A', to: 'd.B', label: evilNote, note: evilNote }],
        };
        document.getElementById('spec').value = JSON.stringify(spec);
        window.render();
        const pv = document.getElementById('preview');
        return { err: document.getElementById('err').textContent, svg: pv.querySelectorAll('svg').length,
          warn: !!pv.querySelector('.warn'), rows: pv.querySelectorAll('table tr').length, pwned: window.pwned };
      }, { evilTitle, evilNote });
      report('export: the hostile spec is VALID and renders in the playground (SVG drawn, no validation box, status strip empty)',
        rendered.err === '' && rendered.svg > 0 && !rendered.warn && rendered.pwned === undefined,
        `err="${rendered.err}" svg=${rendered.svg} warn=${rendered.warn} rows=${rendered.rows}`);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#dl'),
      ]);
      const dlPath = await download.path();
      const exported = dlPath ? fs.readFileSync(dlPath, 'utf8') : '';

      const scriptOpens = (exported.match(/<script>/gi) || []).length;
      const scriptCloses = (exported.match(/<\/script>/gi) || []).length;
      report('export: downloaded file opens with <!doctype html>', /^<!doctype html>/i.test(exported));
      report('export: real download has exactly 2 balanced <script> elements (no early close from spec data)',
        scriptOpens === 2 && scriptCloses === 2, `opens=${scriptOpens} closes=${scriptCloses}`);
      const renderCallLine = exported.split('\n').reverse().find(l => l.includes(", document.getElementById('app'));"));
      const callMatch = renderCallLine && renderCallLine.match(/^<script>renderWiringGuide\(([\s\S]*), document\.getElementById\('app'\)\);<\/script>$/);
      let roundTrip = null, roundTripErr = null;
      try { roundTrip = callMatch && JSON.parse(callMatch[1]); } catch (e) { roundTripErr = e; }
      report('export: embedded spec JSON in the real downloaded file round-trips via JSON.parse',
        !roundTripErr && roundTrip && roundTrip.meta.title === evilTitle && roundTrip.nets[0].note === evilNote,
        roundTripErr ? roundTripErr.message : 'ok');
      const titleMatch = exported.match(/<title>([\s\S]*?)<\/title>/);
      const titleInner = titleMatch && titleMatch[1];
      report('export: <title> in the real downloaded file is HTML-escaped',
        !!titleInner && !/<script/i.test(titleInner) && titleInner.indexOf('&lt;') !== -1, `<title> contents: ${titleInner}`);
      await page.close();

      // Reopen the downloaded file from file:// in a fresh page: the guide
      // must render (real SVG, no validation box, no console/page errors)
      // and the injected script must NOT have executed.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-export-'));
      const exportedPath = path.join(tmp, 'hostile-export.html');
      fs.writeFileSync(exportedPath, exported);
      const page2 = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      const pageErrors = [], consoleErrors = [], requests = [];
      page2.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
      page2.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page2.on('request', r => { if (!r.url().startsWith('file:')) requests.push(r.url()); });
      await page2.goto('file://' + exportedPath);
      await page2.waitForTimeout(300);
      const reopened = await page2.evaluate(() => {
        const app = document.getElementById('app');
        return { title: document.title, svg: app ? app.querySelectorAll('svg').length : 0, warn: !!(app && app.querySelector('.warn')),
          wg: !!(app && app.classList.contains('wg')), pwned: window.pwned, rows: app ? app.querySelectorAll('table tr').length : 0 };
      });
      report('export(reopened from file://): the guide renders — .wg mount, ≥1 SVG, no validation box, no page/console errors',
        reopened.wg && reopened.svg > 0 && !reopened.warn && pageErrors.length === 0 && consoleErrors.length === 0,
        `svg=${reopened.svg} warn=${reopened.warn} rows=${reopened.rows} pageErrors=[${pageErrors.join('; ')}] consoleErrors=[${consoleErrors.join('; ')}]`);
      report('export(reopened from file://): injected script did NOT execute (window.pwned undefined) and document.title is the literal author text',
        reopened.pwned === undefined && reopened.title === evilTitle, `pwned=${reopened.pwned} title=${JSON.stringify(reopened.title)}`);
      report('export(reopened from file://): no external network requests (standalone)', requests.length === 0, requests.join(', ') || 'none');
      await page2.close();
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(failures ? `\n${failures} of ${checks} browser-smoke check(s) FAILED` : `\nbrowser-smoke: all ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
