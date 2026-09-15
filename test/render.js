#!/usr/bin/env node
/* Render-path harness for wiring.js — the SVG/DOM/geometry side that the
 * validation harness (run-validation.js) does not cover. Pure Node, zero deps:
 * a minimal FakeDOM (same FakeElement/FakeDOM idea as run-validation.js §5)
 * stands in for the browser, and every assertion inspects the produced
 * DOM/SVG STRUCTURE — element counts, attributes, coordinates, table HTML —
 * never pixels.
 *
 * Runs two ways:
 *   node test/render.js          — standalone (its own PASS/FAIL + exit code)
 *   require('./render.js').run(report)  — folded into run-validation.js so a
 *   single `node test/run-validation.js` (what CI runs) exercises both.
 *
 * Board geometry constants mirror wiring.js exactly so coordinate math is
 * checked against the renderer's real output, not a paraphrase. If these drift
 * from wiring.js, that is itself a regression the tests should surface. */
'use strict';
const fs = require('fs');
const path = require('path');

const WG = require(path.join(__dirname, '..', 'wiring.js')).WiringGuide;

// ---- geometry constants (must match wiring.js renderWiringGuide) ----
const PITCH = 26, MX = 46, MY = 30, HR = 7.5;
const cx = c => MX + (c - 1) * PITCH;
const cy = r => MY + (r - 1) * PITCH;
const vbFor = (cols, rows) => `0 0 ${MX + cols * PITCH} ${MY + (rows + 1) * PITCH}`;

// ---- minimal FakeDOM (structure only; no layout, no events) ----
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attrs = {};
    this.childNodes = [];
    this.style = {};
    this.textContent = '';
    this._innerHTML = '';
    this._classes = new Set();
    const cl = this._classes;
    this.classList = {
      add: (...cs) => cs.forEach(c => cl.add(c)),
      remove: (...cs) => cs.forEach(c => cl.delete(c)),
      contains: c => cl.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !cl.has(c) : !!force;
        if (on) cl.add(c); else cl.delete(c);
        return on;
      },
    };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  appendChild(child) { this.childNodes.push(child); return child; }
  // Record listeners so tests can drive keyboard/pointer handlers. dispatch()
  // fires every listener for a type with a supplied event object (which carries
  // its own preventDefault). Pointer handlers still no-op in practice because
  // they touch getScreenCTM/createSVGPoint (absent here); the keyboard handler
  // only touches get/setAttribute, so it runs end-to-end.
  addEventListener(type, fn) { (this._listeners || (this._listeners = {}))[type] = ((this._listeners[type] || []).concat(fn)); }
  dispatch(type, event) { (this._listeners && this._listeners[type] || []).forEach(fn => fn(event)); }
  set innerHTML(value) { this._innerHTML = String(value); if (value === '') this.childNodes = []; }
  get innerHTML() { return this._innerHTML; }
}
// NOTE: attachPanZoom runs fully (FakeElement has get/setAttribute), it just
// registers listeners. The POINTER path still no-ops if fired — it needs
// getScreenCTM/createSVGPoint (absent) — but the KEYBOARD path only touches
// get/setAttribute on the viewBox, so dispatching a keydown drives it for real.
function makeDocument() {
  const doc = {
    head: new FakeElement('head'),
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    getElementById(id) {
      const walk = node => node.attrs.id === id ? node : node.childNodes.map(walk).find(Boolean);
      return walk(this.head);
    },
  };
  return doc;
}
const descendants = node => [node].concat(...node.childNodes.map(descendants));
// query helpers over the fake tree
const bySvgClass = (root, cls) => descendants(root).filter(n => n.attrs.class === cls);
const byTag = (root, tag) => descendants(root).filter(n => n.tagName === tag);
const byDataId = (root, id) => descendants(root).filter(n => n.attrs['data-id'] === id);
const htmlOf = root => descendants(root).map(n => n._innerHTML || '').join('\n');

// render a spec into a fresh mount, capturing console.warn output
function renderCapture(spec, opts) {
  const mount = new FakeElement('div');
  const warns = [];
  const origWarn = console.warn, origErr = console.error;
  console.warn = (...a) => warns.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  console.error = () => {};
  let error = null;
  try { WG.render(spec, mount, opts); } catch (e) { error = e; }
  finally { console.warn = origWarn; console.error = origErr; }
  return { mount, warns, error };
}

function run(report) {
  const prevDoc = global.document;
  global.document = makeDocument();
  try {
    runInner(report);
  } finally {
    if (prevDoc === undefined) delete global.document; else global.document = prevDoc;
  }
}

function runInner(report) {
  const P = WG.PRESETS;

  // ==== 1. board-geometry presets (pure builders) ====
  {
    const g = P['perf']({ cols: 5, rows: 4 });
    report('geom: perf honors explicit cols/rows, no buses',
      g.cols === 5 && g.rows === 4 && g.rails.length === 0 && g.segments.length === 0,
      JSON.stringify(g));
  }
  {
    const g = P['perf']({});
    report('geom: perf default grid is 20x20',
      g.cols === 20 && g.rows === 20, `${g.cols}x${g.rows}`);
  }
  {
    const g = P['perf-4x6cm']({}), h = P['perf-5x7cm']({}), i = P['perf-7x9cm']({});
    report('geom: perf-*cm preset sizes (15x24 / 18x24 / 24x36)',
      g.cols === 15 && g.rows === 24 && h.cols === 18 && h.rows === 24 && i.cols === 24 && i.rows === 36,
      `${g.cols}x${g.rows} ${h.cols}x${h.rows} ${i.cols}x${i.rows}`);
  }
  {
    const g = P['breadboard-mini']({});
    // 17 cols; each col has two 5-hole terminal strips (a-e rows1-5, f-j rows7-11); no rails
    const s0 = g.segments[0];
    report('geom: breadboard-mini 17x11, 34 terminal strips, 0 rails',
      g.cols === 17 && g.rows === 11 && g.segments.length === 34 && g.rails.length === 0 &&
      s0.col === 1 && s0.r0 === 1 && s0.r1 === 5,
      `cols${g.cols} rows${g.rows} seg${g.segments.length} rail${g.rails.length} s0=${JSON.stringify(s0)}`);
  }
  {
    const g = P['breadboard-half']({});
    // 30 cols × 2 strips = 60 segments; 4 power rails (rows 1,2,16,17)
    const railRows = g.rails.map(r => r.row).sort((a, b) => a - b).join(',');
    report('geom: breadboard-half 30x17, 60 strips, 4 rails on rows 1,2,16,17',
      g.cols === 30 && g.rows === 17 && g.segments.length === 60 && g.rails.length === 4 &&
      railRows === '1,2,16,17' && g.rails[0].c0 === 1 && g.rails[0].c1 === 30,
      `seg${g.segments.length} rail${g.rails.length} rows=${railRows}`);
  }
  {
    const g = P['jumperless']({});
    // half-breadboard geometry (60 strips, 4 rails) + a NODE label per strip:
    // top strips = node 1-30, the strip across the ravine = node col+30 (31-60).
    // Generic numeric axes are suppressed (node numbers replace them).
    const railLabels = g.rails.map(r => r.label).join(',');
    const top1 = g.nodeLabels.find(n => n.col === 1 && n.row === 3);
    const bot1 = g.nodeLabels.find(n => n.col === 1 && n.row === 15);
    const top30 = g.nodeLabels.find(n => n.col === 30 && n.row === 3);
    const bot30 = g.nodeLabels.find(n => n.col === 30 && n.row === 15);
    report('geom: jumperless 30x17, 60 strips, 4 rails, 60 node labels (1-30 top / 31-60 bottom, col+30), axes off',
      g.cols === 30 && g.rows === 17 && g.segments.length === 60 && g.rails.length === 4 &&
      g.nodeLabels.length === 60 &&
      top1 && top1.text === 1 && bot1 && bot1.text === 31 &&
      top30 && top30.text === 30 && bot30 && bot30.text === 60 &&
      g.noColAxis === true && g.noRowAxis === true &&
      railLabels === 'TOP_RAIL,GND,BOTTOM_RAIL,GND',
      `seg${g.segments.length} rail${g.rails.length} labels${g.nodeLabels.length} rails=${railLabels} top1=${top1 && top1.text} bot1=${bot1 && bot1.text} bot30=${bot30 && bot30.text}`);
  }
  {
    // jumperless with an explicit cols override keeps the +cols node offset
    const g = P['jumperless']({ cols: 10 });
    const bot1 = g.nodeLabels.find(n => n.col === 1 && n.row === 15);
    report('geom: jumperless cols:10 → bottom node = col+10 (node 11), 20 node labels',
      g.cols === 10 && g.nodeLabels.length === 20 && bot1 && bot1.text === 11,
      `cols${g.cols} labels${g.nodeLabels.length} bot1=${bot1 && bot1.text}`);
  }
  {
    const g = P['electrocookie-strip']({ boards: 2 });
    // 2 boards wide: 34x19, rails = outer col of each board (1,17,18,34), 5 runs/row * 19 rows * 2 boards = 190
    const railCols = g.rails.map(r => r.col).join(',');
    const seg = g.segments.find(s => s.row === 1);
    report('geom: electrocookie boards:2 → 34x19, 4 rails at cols 1,17,18,34, 190 segments',
      g.cols === 34 && g.rows === 19 && g.rails.length === 4 && railCols === '1,17,18,34' &&
      g.segments.length === 190 && seg.c0 === 2 && seg.c1 === 4,
      `cols${g.cols} rows${g.rows} railCols=${railCols} seg${g.segments.length}`);
  }
  {
    const g = P['electrocookie-strip']({ boards: { x: 2, y: 2 } });
    report('geom: electrocookie {x:2,y:2} → 34x38, 8 rails, 380 segments',
      g.cols === 34 && g.rows === 38 && g.rails.length === 8 && g.segments.length === 380,
      `cols${g.cols} rows${g.rows} rail${g.rails.length} seg${g.segments.length}`);
  }
  {
    const g = P['electrocookie-strip']({});   // no boards → 1x1
    report('geom: electrocookie default (no boards) → single 17x19 board, 2 rails, 95 segments',
      g.cols === 17 && g.rows === 19 && g.rails.length === 2 && g.segments.length === 95,
      `cols${g.cols} rows${g.rows} rail${g.rails.length} seg${g.segments.length}`);
  }

  // ==== 2. geometry reaches the rendered SVG (counts + coordinate math) ====
  {
    const { mount, error } = renderCapture({ board: { preset: 'breadboard-half' }, components: [], nets: [] });
    const svg = byTag(mount, 'svg')[0];
    const holes = bySvgClass(svg, 'hole').filter(n => n.tagName === 'circle');
    const segs = bySvgClass(svg, 'seg');
    const rails = bySvgClass(svg, 'rail');
    report('render: breadboard-half draws 510 holes, 60 seg rects, 4 rail rects',
      !error && holes.length === 30 * 17 && segs.length === 60 && rails.length === 4,
      error ? String(error) : `holes${holes.length} seg${segs.length} rail${rails.length}`);
    report('render: breadboard-half svg viewBox math (0 0 826 498)',
      !error && svg && svg.attrs.viewBox === vbFor(30, 17), svg && svg.attrs.viewBox);
  }
  {
    const { mount, error } = renderCapture({ board: { preset: 'jumperless' }, components: [], nets: [] });
    const svg = byTag(mount, 'svg')[0];
    const holes = bySvgClass(svg, 'hole').filter(n => n.tagName === 'circle');
    const segs = bySvgClass(svg, 'seg');
    const texts = bySvgClass(svg, 'glabel').map(t => String(t.textContent)).filter(Boolean);
    // node numbers reach the svg; because the generic axes are suppressed, the
    // ONLY source of a '60' label is the bottom-strip node number (not an axis).
    report('render: jumperless svg has node labels 1/30/31/60 + rail names, 60 strips',
      !error && holes.length === 30 * 17 && segs.length === 60 &&
      texts.includes('1') && texts.includes('30') && texts.includes('31') && texts.includes('60') &&
      texts.includes('TOP_RAIL') && texts.includes('BOTTOM_RAIL'),
      error ? String(error) : `holes${holes.length} seg${segs.length} labels[${texts.slice(0, 6).join(',')}...]`);
  }
  {
    // explicit-grid path of resolveBoard (no preset): cols/rows/rails/segments verbatim
    const spec = {
      board: { cols: 6, rows: 5, rails: [{ col: 1, r0: 1, r1: 5 }], segments: [{ row: 1, c0: 1, c1: 3 }] },
      components: [], nets: [],
    };
    const { mount, error } = renderCapture(spec);
    const svg = byTag(mount, 'svg')[0];
    report('render: explicit grid (no preset) honored — 30 holes, 1 seg, 1 rail, viewBox',
      !error && bySvgClass(svg, 'hole').length === 30 && bySvgClass(svg, 'seg').length === 1 &&
      bySvgClass(svg, 'rail').length === 1 && svg.attrs.viewBox === vbFor(6, 5),
      error ? String(error) : svg.attrs.viewBox);
  }
  {
    // a specific hole's coordinates are exactly cx()/cy() with r = HR
    const { mount } = renderCapture({ board: { preset: 'perf', cols: 5, rows: 5 }, components: [], nets: [] });
    const svg = byTag(mount, 'svg')[0];
    const target = bySvgClass(svg, 'hole').find(n => n.attrs.cx === String(cx(3)) && n.attrs.cy === String(cy(4)));
    report('render: hole (3,4) sits at cx=98,cy=108,r=7.5 (pitch/margin math)',
      !!target && target.attrs.cx === '98' && target.attrs.cy === '108' && Number(target.attrs.r) === HR,
      target ? `${target.attrs.cx},${target.attrs.cy} r=${target.attrs.r}` : 'hole not found');
  }

  // ==== 3. net rendering: kinds, endpoints, colors, labels, values, notes ====
  {
    const spec = {
      board: { preset: 'perf', cols: 20, rows: 20 }, components: [],
      nets: [
        { id: 'J1', kind: 'jumper', from: [1, 1], to: [3, 1], color: 'gnd', label: 'Ground jump', note: 'to the rail' },
        { id: 'R1', kind: 'resistor', from: [1, 2], to: [1, 4], value: '10k' },
        { id: 'D1', kind: 'diode', from: [5, 5], to: [5, 7], color: '#ff00aa' },
        { id: 'C1', kind: 'cap', from: [8, 1], to: [10, 1], value: '100nF' },
      ],
    };
    const { mount, error } = renderCapture(spec);
    const svg = byTag(mount, 'svg')[0];

    const j = byDataId(svg, 'J1').find(n => n.attrs.class === 'wire');
    report('net: jumper → <path class=wire> with exact M/L endpoints and keyed gnd color',
      !error && j && j.attrs.d === `M${cx(1)},${cy(1)} L${cx(3)},${cy(1)}` && j.style.stroke === '#3b82f6',
      j ? `d=${j.attrs.d} stroke=${j.style.stroke}` : 'no wire');

    const r = byDataId(svg, 'R1').find(n => n.attrs.class === 'resistor');
    report('net: resistor → <path class=resistor>, zigzag path, default r color #b45309',
      !!r && r.style.stroke === '#b45309' && /^M46,56/.test(r.attrs.d) && /L46,108$/.test(r.attrs.d) && (r.attrs.d.match(/L/g) || []).length >= 6,
      r ? `stroke=${r.style.stroke} d=${r.attrs.d}` : 'no resistor');

    const cap = byDataId(svg, 'C1').find(n => n.attrs.class === 'resistor');
    report('net: cap renders with resistor styling + default r color (kind cap → r)',
      !!cap && cap.style.stroke === '#b45309',
      cap ? cap.style.stroke : 'no cap path');

    const dPath = byDataId(svg, 'D1').find(n => n.attrs.class === 'diode');
    const dBand = byDataId(svg, 'D1').find(n => n.tagName === 'line');
    report('net: diode → straight <path class=diode> + cathode band <line>, raw #hex color',
      !!dPath && dPath.attrs.d === `M${cx(5)},${cy(5)} L${cx(5)},${cy(7)}` && dPath.style.stroke === '#ff00aa' &&
      !!dBand && dBand.attrs.stroke === '#ff00aa',
      `path=${dPath && dPath.attrs.d} band=${!!dBand}`);

    // default color inference by kind: jumper→sig when color omitted
    const spec2 = { board: { preset: 'perf', cols: 5, rows: 5 }, components: [],
      nets: [{ id: 'X', kind: 'jumper', from: [1, 1], to: [2, 1] }] };
    const x = byDataId(byTag(renderCapture(spec2).mount, 'svg')[0], 'X')[0];
    report('net: jumper with no color defaults to sig (#eab308)',
      !!x && x.style.stroke === '#eab308', x && x.style.stroke);

    // wires table: one row per net; label/value/note/color-swatch all present
    const rows = descendants(mount).filter(n => n.tagName === 'tr' && n.attrs.class === 'wrow');
    const tblHtml = byTag(mount, 'table').map(t => t._innerHTML).join('\n') +
      rows.map(r2 => r2._innerHTML).join('\n');
    report('net: wires table has one row per net (4) with labels, values, notes, swatch colors',
      rows.length === 4 &&
      /Ground jump/.test(tblHtml) && /to the rail/.test(tblHtml) &&   // label + note
      /10k/.test(tblHtml) && /100nF/.test(tblHtml) &&                 // values reach the table
      /background:#3b82f6/.test(tblHtml),                             // keyed color → swatch hex
      `rows=${rows.length}`);
  }

  // ==== 4. component spans, labels, notes, duplicate labels ====
  {
    const spec = {
      board: { preset: 'perf', cols: 12, rows: 8 },
      components: [{
        id: 'esp', label: 'ESP32', span: [[2, 3], [6, 3]],   // 1-row span → label ABOVE
        pins: [
          { label: 'GPIO34', loc: [2, 3], notes: 'ADC1_CH6' },
          { label: 'GND', loc: [4, 3] },
          { label: 'GND', loc: [6, 3] },                       // duplicate label, distinct hole (bug #7)
        ],
      }],
      labels: { '2,3': '34' },                                 // short hole-text override
      nets: [],
    };
    const { mount, error } = renderCapture(spec);
    const svg = byTag(mount, 'svg')[0];

    const outline = bySvgClass(svg, 'comp-outline')[0];
    report('component: 1-row span → outline rect at cx(c0)-13/cy(r0)-13 with padded w/h',
      !error && outline &&
      outline.attrs.x === String(cx(2) - 13) && outline.attrs.y === String(cy(3) - 13) &&
      outline.attrs.width === String((6 - 2) * PITCH + 26) && outline.attrs.height === String(0 * PITCH + 26),
      outline ? `x${outline.attrs.x} y${outline.attrs.y} w${outline.attrs.width} h${outline.attrs.height}` : 'no outline');

    // label text for a short (<=1 row) span is placed ABOVE the hole row (cy(r0)-20)
    const label = byTag(svg, 'text').find(n => n.textContent === 'ESP32');
    report('component: short-span label renders ABOVE the row (y = cy(r0)-20, centered)',
      !!label && label.attrs.y === String(cy(3) - 20) && Number(label.attrs.y) < cy(3) &&
      label.attrs.x === String(cx(4)) && label.attrs['text-anchor'] === 'middle',
      label ? `x${label.attrs.x} y${label.attrs.y}` : 'no label');

    // pins map to labeled holes: three hlabel texts at the three pin holes
    const hlabels = bySvgClass(svg, 'hlabel');
    const coordSet = new Set(hlabels.map(n => `${n.attrs.x},${n.attrs.y}`));
    report('component: each pin becomes a labeled hole (3 hlabels at the 3 pin coords)',
      hlabels.length === 3 && coordSet.size === 3 &&
      coordSet.has(`${cx(2)},${cy(3)}`) && coordSet.has(`${cx(4)},${cy(3)}`) && coordSet.has(`${cx(6)},${cy(3)}`),
      `count=${hlabels.length} coords=${[...coordSet].join(' ')}`);

    // short override changes the DRAWN canvas text to "34" (pin identity stays GPIO34)
    const drawnAt23 = hlabels.find(n => n.attrs.x === String(cx(2)) && n.attrs.y === String(cy(3)));
    const gpio34Drawn = hlabels.some(n => n.textContent === 'GPIO34');
    report('labels: short override draws "34" on the canvas (GPIO34 never drawn), identity kept',
      drawnAt23 && drawnAt23.textContent === '34' && !gpio34Drawn,
      drawnAt23 ? `drawn=${drawnAt23.textContent} gpio34OnCanvas=${gpio34Drawn}` : 'missing');

    // pin table: GPIO34 identity + notes + "drawn" override annotation
    const pinTableHtml = htmlOf(mount);
    report('labels+notes: pin table shows GPIO34, its note, a Notes column, and the drawn "34" override',
      /GPIO34/.test(pinTableHtml) && /ADC1_CH6/.test(pinTableHtml) && /Notes/.test(pinTableHtml) && /drawn/.test(pinTableHtml) && /“34”/.test(pinTableHtml),
      'pin table html checked');

    // bug #7: duplicate "GND" labels occupy TWO distinct holes on the canvas
    const gndHoles = new Set(hlabels.filter(n => n.textContent === 'GND').map(n => `${n.attrs.x},${n.attrs.y}`));
    report('labels: two identical "GND" labels stay distinct holes (bug #7 regression lock)',
      gndHoles.size === 2 &&
      gndHoles.has(`${cx(4)},${cy(3)}`) && gndHoles.has(`${cx(6)},${cy(3)}`),
      `distinct GND holes=${gndHoles.size}`);
  }

  // ==== 5. DRC / collision overlay (red box + console.warn), and its socket exemption ====
  {
    // two net legs into one hole → hazard
    const twoLegs = renderCapture({
      board: { preset: 'perf', cols: 6, rows: 6 }, components: [],
      nets: [{ id: 'A', kind: 'jumper', from: [1, 1], to: [2, 2] },
             { id: 'B', kind: 'jumper', from: [3, 3], to: [2, 2] }],
    });
    const legBanner = descendants(twoLegs.mount).some(n => n.tagName === 'div' && /hole collision/i.test(n._innerHTML));
    report('DRC: ≥2 net legs on one hole → red collision banner + console.warn',
      legBanner && twoLegs.warns.some(w => /collision/i.test(w)),
      `banner=${legBanner} warned=${twoLegs.warns.some(w => /collision/i.test(w))}`);

    // a net leg landing on a NON-socket component pin → hazard
    const legOnPin = renderCapture({
      board: { preset: 'perf', cols: 6, rows: 6 },
      components: [{ id: 'term', label: 'Screw', pins: [{ label: 'GND', loc: [5, 5] }] }], // no socket:true
      nets: [{ id: 'A', kind: 'jumper', from: [1, 1], to: [5, 5] }],
    });
    report('DRC: leg on a non-socket part pin → collision banner fires',
      descendants(legOnPin.mount).some(n => n.tagName === 'div' && /hole collision/i.test(n._innerHTML)),
      'checked');

    // same wiring, pin marked socket:true → NO hazard (socket exemption)
    const legOnSocket = renderCapture({
      board: { preset: 'perf', cols: 6, rows: 6 },
      components: [{ id: 'esp', label: 'ESP', socket: true, pins: [{ label: 'GND', loc: [5, 5] }] }],
      nets: [{ id: 'A', kind: 'jumper', from: [1, 1], to: [5, 5] }],
    });
    const socketBanner = descendants(legOnSocket.mount).some(n => n.tagName === 'div' && /hole collision/i.test(n._innerHTML));
    report('DRC: leg on a socket:true pin is fine — no collision banner, no warn',
      !socketBanner && !legOnSocket.warns.some(w => /collision/i.test(w)),
      `banner=${socketBanner}`);

    // drc:false suppresses the overlay even when a hazard exists
    const drcOff = renderCapture({
      board: { preset: 'perf', cols: 6, rows: 6 }, components: [],
      nets: [{ id: 'A', kind: 'jumper', from: [1, 1], to: [2, 2] },
             { id: 'B', kind: 'jumper', from: [3, 3], to: [2, 2] }],
    }, { drc: false });
    report('DRC: option drc:false suppresses the collision banner despite the hazard',
      !descendants(drcOff.mount).some(n => n.tagName === 'div' && /hole collision/i.test(n._innerHTML)),
      'checked');
  }

  // ==== 6. options + palette + public API surface ====
  {
    const light = renderCapture({ board: { preset: 'perf', cols: 4, rows: 4 }, components: [], nets: [] }, { theme: 'light' });
    const dark = renderCapture({ board: { preset: 'perf', cols: 4, rows: 4 }, components: [], nets: [] });
    report('options: theme:light adds .wg-light to the mount; default does not',
      light.mount.classList.contains('wg') && light.mount.classList.contains('wg-light') &&
      dark.mount.classList.contains('wg') && !dark.mount.classList.contains('wg-light'),
      `light=${light.mount.classList.contains('wg-light')} dark=${dark.mount.classList.contains('wg-light')}`);

    report('palette: keyed colors resolve to the documented hex values',
      WG.PALETTE.gnd === '#3b82f6' && WG.PALETTE.sig === '#eab308' && WG.PALETTE.r === '#b45309' &&
      WG.PALETTE.d === '#10b981' && WG.PALETTE.cap === '#06b6d4',
      'checked');

    // The library exposes NO standalone-HTML export — that lives in index.html's
    // playground UI (Blob download), not the renderer. Lock the public surface so
    // a future refactor can't silently drop one of these.
    const surface = ['render', 'renderPointToPoint', 'validate', 'normalizeSpec', 'PRESETS', 'PALETTE', 'PINOUTS', 'MODULES', 'WiringValidationError'];
    report('API: WiringGuide exposes the documented surface (no standalone-HTML export — that is UI-only)',
      surface.every(k => k in WG) && typeof WG.render === 'function' && typeof WG.validate === 'function' &&
      typeof WG.renderPointToPoint === 'function',
      surface.filter(k => !(k in WG)).join(',') || 'all present');
  }

  // ==== 7. end-to-end: the shipped divider demo renders its full net inventory ====
  {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'specs', 'demo-divider-adc.json'), 'utf8'));
    // buildOrder/checks decoration needs createTreeWalker/NodeFilter (real DOM
    // only); disable them so the geometry/net render path can be exercised headless.
    const { mount, error } = renderCapture(spec, { buildOrder: false, checks: false });
    const svg = byTag(mount, 'svg')[0];
    const wires = bySvgClass(svg, 'wire');
    const resistors = bySvgClass(svg, 'resistor');
    const diodes = bySvgClass(svg, 'diode');
    const rows = descendants(mount).filter(n => n.tagName === 'tr' && n.attrs.class === 'wrow');
    report('e2e: divider demo renders 10 jumpers, 4 resistors, 2 diodes and a 16-row wires table',
      !error && wires.length === 10 && resistors.length === 4 && diodes.length === 2 && rows.length === 16,
      error ? String(error) : `wire${wires.length} res${resistors.length} diode${diodes.length} rows${rows.length}`);

    const holes = bySvgClass(svg, 'hole').filter(n => n.tagName === 'circle');
    report('e2e: divider demo board is electrocookie boards:2 → 646 holes, 190 segs, 4 rails',
      !error && holes.length === 34 * 19 && bySvgClass(svg, 'seg').length === 190 && bySvgClass(svg, 'rail').length === 4,
      error ? String(error) : `holes${holes.length}`);

    const html = htmlOf(mount);
    report('e2e: divider demo emits both component pin tables (ESP + screw terminal)',
      /ESP32 DevKit V1 \(30-pin\) pins/.test(html) && /Screw terminal \(3-pin\) pins/.test(html),
      'pin tables checked');
  }

  // ==== modules: a `module` ref expands to labeled, role-typed pins ====
  {
    // HC-SR04 module (4 pins, no author pins) wired to an Arduino Uno in p2p mode.
    // The module's canonical labels + its default label must reach the render.
    const { mount, error } = renderCapture({
      mode: 'point-to-point',
      components: [
        { id: 'd', module: 'hc-sr04' },
        { id: 'u', pinout: 'arduino-uno-r3', pins: [{ label: '5V' }, { label: 'GND' }, { label: 'D2' }, { label: 'D3' }] },
      ],
      nets: [
        { id: 'PWR', from: 'u.5V', to: 'd.VCC' }, { id: 'GND', from: 'u.GND', to: 'd.GND' },
        { id: 'TRIG', from: 'u.D2', to: 'd.TRIG' }, { id: 'ECHO', from: 'u.D3', to: 'd.ECHO' },
      ],
    }, { buildOrder: false, checks: false });
    const svg = byTag(mount, 'svg')[0];
    const pinLabels = svg ? bySvgClass(svg, 'p2p-pinlabel').map(t => String(t.textContent)) : [];
    const hasModulePins = ['VCC', 'TRIG', 'ECHO', 'GND'].every(l => pinLabels.includes(l));
    const html = htmlOf(mount);
    report('module: HC-SR04 `module` ref expands to its 4 labeled pins + default board label',
      !error && hasModulePins && /HC-SR04 ultrasonic ranger pinout/.test(html),
      error ? String(error) : `pins=[${pinLabels.join(',')}] labelInHtml=${/HC-SR04 ultrasonic ranger pinout/.test(html)}`);
  }

  // ==== hardening: bad render args fail with a clear TypeError, not an opaque crash ====
  {
    const grab = fn => { try { fn(); return null; } catch (e) { return e; } };
    const noMount = grab(() => WG.render({ board: { preset: 'perf' }, components: [], nets: [] }, null));
    const noSpec = grab(() => WG.render(null, new FakeElement('div')));
    report('hardening: render() with no mount throws a clear TypeError',
      noMount instanceof TypeError && /DOM element to mount into/.test(noMount.message),
      noMount ? noMount.message : 'no error thrown');
    report('hardening: render() with no spec throws a clear TypeError',
      noSpec instanceof TypeError && /needs a spec object/.test(noSpec.message),
      noSpec ? noSpec.message : 'no error thrown');
  }

  // ==== meta.notes: string → neutral, typed → colored, none render empty ====
  {
    const { mount, error } = renderCapture({
      meta: { title: 'notes', notes: ['plain string note', { type: 'ok', html: 'green ok' }, { type: 'warn', html: 'red warn' }, { type: 'note', html: 'neutral explicit' }] },
      board: { preset: 'perf', cols: 3, rows: 3 }, components: [], nets: [],
    });
    const divs = c => descendants(mount).filter(n => n.tagName === 'div' && n.attrs.class === c);
    const notes = divs('note'), oks = divs('ok'), warns = divs('warn');
    const strHit = notes.some(d => (d.textContent || d._innerHTML) === 'plain string note');
    // string + {type:'note'} → 2 neutral; ok → 1; warn → 1; the string never renders empty
    report('render: meta.notes — string+note → .note (x2), ok → .ok, warn → .warn, string not empty',
      !error && notes.length === 2 && oks.length === 1 && warns.length === 1 && strHit,
      error ? String(error) : `note${notes.length} ok${oks.length} warn${warns.length} strHit=${strHit}`);
  }

  // ==== WG-08: a warning-only meta.notes must NOT crash render ====
  {
    // validate() reports a non-array `notes` as a WARNING (documented: never
    // fatal). The renderer used to .forEach the string and throw — so the
    // documented non-fatal condition was fatal in practice. Now it renders,
    // shows the warning box, and draws no notes.
    const { mount, error, warns } = renderCapture({
      meta: { title: 'bad notes', notes: 'oops' },
      board: { preset: 'perf', cols: 3, rows: 3 }, components: [], nets: [],
    });
    const noteDivs = descendants(mount).filter(n => n.tagName === 'div' && ['note', 'ok'].includes(n.attrs.class));
    const banner = descendants(mount).some(n => n.tagName === 'div' && n.attrs.class === 'warn' && /validation warning.*meta\.notes.*must be an array/.test(n._innerHTML));
    const svg = byTag(mount, 'svg')[0];
    report('WG-08: meta.notes:"oops" renders (no throw), shows the warning box, draws no note bars',
      !error && banner && noteDivs.length === 0 && !!svg && warns.some(w => /must be an array/.test(w)),
      error ? String(error) : `banner=${banner} noteDivs=${noteDivs.length} svg=${!!svg}`);
  }

  // ==== WG-02: geometry failures are a VALIDATION error at render, never a crash ====
  {
    const grab = spec => renderCapture(spec);
    const isValidationFail = r => r.error instanceof WG.WiringValidationError &&
      descendants(r.mount).some(n => n.tagName === 'div' && /VALIDATION FAILED/.test(n._innerHTML)) &&
      byTag(r.mount, 'svg').length === 0;

    // unresolved named endpoint in board mode: was `TypeError: Cannot read properties of undefined (reading 'join')`
    const unresolved = grab({ board: { preset: 'perf', cols: 5, rows: 5 },
      components: [{ id: 'esp', pins: [{ label: 'GND', loc: [1, 1] }] }],
      nets: [{ id: 'N1', from: 'esp.NOPE', to: [2, 2] }] });
    report('WG-02 render: unresolved "comp.pin" endpoint in board mode → WiringValidationError + red box, no TypeError, no SVG',
      isValidationFail(unresolved) && /has no pin "NOPE"/.test(unresolved.error.message),
      unresolved.error ? `${unresolved.error.name}: ${unresolved.error.message.split('\n')[0]}` : 'no error thrown');

    // unknown preset: was a silent fallback to the 20×20 default board
    const typo = grab({ board: { preset: 'breadboard-hlaf' }, components: [], nets: [] });
    report('WG-02 render: unknown preset → WiringValidationError (no silent 20x20 fallback board)',
      isValidationFail(typo) && /not a known preset/.test(typo.error.message),
      typo.error ? typo.error.message.split('\n')[0] : 'rendered a board');

    // off-board wire: was drawn clipped outside the viewBox
    const clipped = grab({ board: { preset: 'perf', cols: 5, rows: 5 }, components: [], nets: [{ id: 'N1', from: [1, 1], to: [99, 99] }] });
    report('WG-02 render: off-board wire → WiringValidationError (nothing drawn outside the viewBox)',
      isValidationFail(clipped) && /off the board/.test(clipped.error.message),
      clipped.error ? clipped.error.message.split('\n')[0] : 'rendered a board');

    // duplicate net ids: was one table row highlighting two drawn objects
    const dup = grab({ board: { preset: 'perf', cols: 5, rows: 5 }, components: [],
      nets: [{ id: 'N1', from: [1, 1], to: [2, 2] }, { id: 'N1', from: [3, 3], to: [4, 4] }] });
    report('WG-02 render: duplicate net ids → WiringValidationError',
      isValidationFail(dup) && /duplicate net id "N1"/.test(dup.error.message),
      dup.error ? dup.error.message.split('\n')[0] : 'rendered a board');

    // p2p unresolved endpoint: was an SVG with ZERO wires + a warning (connection silently omitted)
    const p2pDrop = grab({ mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X' }] }],
      nets: [{ id: 'N1', from: 'a.X', to: 'a.NOPE' }] });
    report('WG-02 render (p2p): unresolved endpoint a.NOPE → WiringValidationError, no wire-less SVG',
      isValidationFail(p2pDrop) && /has no pin "NOPE"/.test(p2pDrop.error.message),
      p2pDrop.error ? p2pDrop.error.message.split('\n')[0] : 'rendered an SVG');

    // p2p string loc: was `TypeError: p.loc.join is not a function` in Chromium
    const p2pLoc = grab({ mode: 'point-to-point', components: [{ id: 'a', pins: [{ label: 'X', loc: 'oops' }] }], nets: [] });
    report('WG-02 render (p2p): pin loc:"oops" → WiringValidationError, not a p.loc.join TypeError',
      isValidationFail(p2pLoc) && /loc, when given, must be/.test(p2pLoc.error.message),
      p2pLoc.error ? `${p2pLoc.error.name}: ${p2pLoc.error.message.split('\n')[0]}` : 'rendered');
  }

  // ==== WG-02 follow-up: reversed geometry is NORMALIZED, never a negative rect ====
  {
    const { mount, error } = renderCapture({
      board: { cols: 8, rows: 8, rails: [{ row: 1, c0: 5, c1: 1, label: 'V+' }], segments: [{ col: 7, r0: 6, r1: 2 }] },
      components: [{ id: 'x', label: 'X', span: [[5, 5], [1, 1]], pins: [] }], nets: [],
    });
    const svg = byTag(mount, 'svg')[0];
    const outline = bySvgClass(svg, 'comp-outline')[0];
    report('normalize: reversed span [[5,5],[1,1]] → outline at the (1,1) corner with POSITIVE 4-pitch w/h',
      !error && outline && outline.attrs.x === String(cx(1) - 13) && outline.attrs.y === String(cy(1) - 13) &&
      outline.attrs.width === String(4 * PITCH + 26) && outline.attrs.height === String(4 * PITCH + 26),
      error ? String(error) : outline ? `x${outline.attrs.x} y${outline.attrs.y} w${outline.attrs.width} h${outline.attrs.height}` : 'no outline');
    const rail = bySvgClass(svg, 'rail')[0];
    report('normalize: reversed rail {row:1,c0:5,c1:1} → rect starts at cx(1) with POSITIVE width (was width="-86")',
      !!rail && rail.attrs.x === String(cx(1) - 9) && rail.attrs.width === String(4 * PITCH + 18) && Number(rail.attrs.width) > 0,
      rail ? `x${rail.attrs.x} w${rail.attrs.width}` : 'no rail');
    const railLabel = byTag(svg, 'text').find(t => t.textContent === 'V+');
    report('normalize: reversed rail label sits at the LOW column end',
      !!railLabel && railLabel.attrs.x === String(cx(1) - 6), railLabel ? `x${railLabel.attrs.x}` : 'no label');
    const seg = bySvgClass(svg, 'seg')[0];
    report('normalize: reversed segment {col:7,r0:6,r1:2} → rect starts at cy(2) with POSITIVE height',
      !!seg && seg.attrs.y === String(cy(2) - 11) && seg.attrs.height === String(4 * PITCH + 22),
      seg ? `y${seg.attrs.y} h${seg.attrs.height}` : 'no seg');
  }

  // ==== accessibility: SVG role/title/desc, per-wire title, keyboard rows ====
  {
    const { mount, error } = renderCapture({
      meta: { title: 'A11y Board', intro: 'An intro line.' },
      board: { preset: 'perf', cols: 6, rows: 6 },
      components: [{ id: 'a', pins: [{ label: 'X', loc: [1, 1] }] }, { id: 'b', pins: [{ label: 'Y', loc: [3, 3] }] }],
      nets: [{ id: 'N1', from: [1, 1], to: [3, 3], label: 'wire one' }],
    });
    const svg = byTag(mount, 'svg')[0];
    const svgTitle = svg && svg.childNodes.find(n => n.tagName === 'title');
    const svgDesc = svg && svg.childNodes.find(n => n.tagName === 'desc');
    const wire = bySvgClass(svg, 'wire')[0];
    const wireT = wire && wire.childNodes.find(n => n.tagName === 'title');
    const wrow = byTag(mount, 'tr').find(n => n.attrs.class === 'wrow');
    report('a11y: svg role=img + <title>(meta.title) + <desc>(intro + table pointer)',
      !error && svg.attrs.role === 'img' && svgTitle && svgTitle.textContent === 'A11y Board' &&
      svgDesc && /An intro line\./.test(svgDesc.textContent) && /text equivalent/.test(svgDesc.textContent),
      error ? String(error) : `role=${svg && svg.attrs.role} title=${svgTitle && svgTitle.textContent}`);
    report('a11y: each wire carries a <title> naming label + role (non-color identification)',
      !!wireT && wireT.textContent === 'wire one — signal', wireT ? wireT.textContent : 'no wire <title>');
    // ARIA lives on a REAL <button> inside the swatch cell — never on the <tr>
    // itself (aria-pressed/tabindex on a bare row is invalid ARIA and would
    // also strip the row's table semantics).
    const rowHtml = wrow ? wrow._innerHTML : '';
    report('a11y: wires-table row carries a real toggle <button aria-pressed> in its swatch cell, none on the <tr>',
      !!wrow && wrow.attrs.tabindex === undefined && wrow.attrs['aria-pressed'] === undefined &&
      /<td class="sw"><button type="button" class="rowbtn" aria-pressed="false" aria-label="Highlight wire one on the diagram">/.test(rowHtml),
      wrow ? `tr.tabindex=${wrow.attrs.tabindex} tr.aria-pressed=${wrow.attrs['aria-pressed']} cell=${rowHtml.slice(0, 120)}` : 'no wrow');
  }

  // ==== a11y: keyboard pan/zoom on the SVG =================================
  {
    const { mount, error } = renderCapture({
      meta: { title: 'Keyboard PZ' },
      board: { preset: 'perf', cols: 6, rows: 6 },
      components: [{ id: 'a', pins: [{ label: 'X', loc: [1, 1] }] }],
      nets: [],
    });
    const svg = byTag(mount, 'svg')[0];
    const parseVB = () => svg.attrs.viewBox.trim().split(/\s+/).map(Number);
    const ev = key => ({ key, shiftKey: false, _pd: false, preventDefault() { this._pd = true; } });
    const initialVB = svg && svg.attrs.viewBox;

    report('a11y: SVG is focusable + advertises keyboard shortcuts',
      !error && svg && svg.attrs.tabindex === '0' && /ArrowUp/.test(svg.attrs['aria-keyshortcuts'] || ''),
      svg ? `tabindex=${svg.attrs.tabindex} keyshortcuts=${svg.attrs['aria-keyshortcuts']}` : 'no svg');

    // pan right: viewBox x increases, size unchanged
    const [x0, y0, w0, h0] = parseVB();
    let e = ev('ArrowRight'); svg.dispatch('keydown', e);
    let [x1, , w1, h1] = parseVB();
    report('a11y: ArrowRight pans (viewBox x increases, size fixed) + preventDefault',
      x1 > x0 && w1 === w0 && h1 === h0 && e._pd === true, `x ${x0}→${x1} pd=${e._pd}`);

    // pan up: viewBox y decreases
    e = ev('ArrowUp'); svg.dispatch('keydown', e);
    const [, y2] = parseVB();
    report('a11y: ArrowUp pans (viewBox y decreases)', y2 < y0, `y ${y0}→${y2}`);

    // zoom in ('+'): width shrinks, center held (x moves right, y down as it narrows)
    svg.setAttribute('viewBox', initialVB); // reset to a known state
    const [zx0, zy0, zw0] = parseVB();
    e = ev('+'); svg.dispatch('keydown', e);
    const [zx1, zy1, zw1] = parseVB();
    const centerHeld = Math.abs((zx1 + zw1 / 2) - (zx0 + zw0 / 2)) < 1e-6;
    report('a11y: "+" zooms in about center (width shrinks, center fixed)',
      zw1 < zw0 && centerHeld && zx1 > zx0 && zy1 > zy0, `w ${zw0}→${zw1} centerHeld=${centerHeld}`);

    // zoom out ('-'): width grows back
    e = ev('-'); svg.dispatch('keydown', e);
    const [, , zw2] = parseVB();
    report('a11y: "-" zooms out (width grows)', zw2 > zw1, `w ${zw1}→${zw2}`);

    // reset ('0'): back to the initial viewBox
    svg.dispatch('keydown', ev('ArrowRight')); // move away first
    svg.dispatch('keydown', ev('0'));
    report('a11y: "0" resets the viewBox to initial', svg.attrs.viewBox === initialVB,
      `${svg.attrs.viewBox} vs ${initialVB}`);

    // an unhandled key is left alone (no preventDefault, viewBox unchanged)
    svg.setAttribute('viewBox', initialVB);
    e = ev('a'); svg.dispatch('keydown', e);
    report('a11y: a non-navigation key is ignored (no preventDefault, viewBox unchanged)',
      e._pd === false && svg.attrs.viewBox === initialVB, `pd=${e._pd}`);
  }

  // ==== a11y: colorblind-safe pattern-per-role (dash + legend + title) ======
  {
    const { mount, error } = renderCapture({
      meta: { title: 'Roles' },
      board: { preset: 'perf', cols: 8, rows: 6 },
      components: [{ id: 'a', pins: [{ label: 'X', loc: [1, 1] }] }],
      nets: [
        { id: 'PWR', from: [1, 1], to: [2, 1], color: 'in', label: 'power in' },
        { id: 'GND', from: [1, 2], to: [2, 2], color: 'gnd', label: 'ground' },
        { id: 'SIG', from: [1, 3], to: [2, 3], color: 'sig', label: 'signal' },
        { id: 'NODE', from: [1, 4], to: [2, 4], color: 'node', label: 'node tie' },
      ],
      legend: [
        { color: 'in', label: 'power' }, { color: 'gnd', label: 'ground' },
        { color: 'sig', label: 'signal' }, { color: 'node', label: 'node' },
      ],
    });
    const svg = byTag(mount, 'svg')[0];
    const dashOfId = id => { const p = byDataId(svg, id).find(n => n.attrs.class === 'wire'); return p ? p.attrs['stroke-dasharray'] : undefined; };

    // each role gets a DISTINCT non-color channel; power stays solid (no dash)
    const dIn = dashOfId('PWR'), dGnd = dashOfId('GND'), dSig = dashOfId('SIG'), dNode = dashOfId('NODE');
    const distinct = new Set([dGnd, dSig, dNode]).size === 3 && dGnd && dSig && dNode;
    report('pattern-per-role: gnd/sig/node each get a distinct stroke-dasharray; power (in) solid',
      !error && dIn === undefined && distinct, `in=${dIn} gnd=${dGnd} sig=${dSig} node=${dNode}`);

    // color is KEPT (additive) — the ground wire still strokes blue
    const gndWire = byDataId(svg, 'GND').find(n => n.attrs.class === 'wire');
    report('pattern-per-role: color channel retained (gnd wire still #3b82f6)',
      gndWire && gndWire.style.stroke === '#3b82f6', gndWire && gndWire.style.stroke);

    // legend swatch now carries BOTH color and the dash pattern (a line, not a box)
    const legendHtml = htmlOf(mount);
    report('pattern-per-role: legend swatch is a line carrying color + dash pattern',
      /swatch-line/.test(legendHtml) && /stroke="#3b82f6"/.test(legendHtml) && /stroke-dasharray="9,6"/.test(legendHtml),
      'legend swatch-line + color + dash present');

    // <title> names the role for each wire (text equivalent, color+dash stripped)
    const gTitle = byDataId(svg, 'GND').map(n => n.childNodes.find(c => c.tagName === 'title')).find(Boolean);
    report('pattern-per-role: wire <title> names label + role',
      gTitle && gTitle.textContent === 'ground — ground', gTitle && gTitle.textContent);
  }

  // ==== text palette: author hex → AA text color (adversarial) ==============
  // The check must hold on the ROUNDED color (what CSS receives), for every
  // hex length, and alpha forms must come back opaque. Contrast math mirrors
  // WCAG 2 (same formula the renderer uses) against the theme panel colors.
  {
    const panel = { dark: [0x16, 0x1b, 0x22], light: [0xf6, 0xf8, 0xfa] };
    const rgbOf = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const cr = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    // the two post-rounding near-misses Betty caught (4.48:1), alpha forms,
    // every digit length, both extremes, mixed case
    const cases = ['#112', '#9e7', '#00000000', '#ffffff80', '#0000', '#f0f8', '#b45309', '#123456', '#FFF', '#000000ff', '#eab308', '#8b949e'];
    const bad = [];
    for (const theme of ['dark', 'light']) for (const hex of cases) {
      const out = WG.accessibleHex(hex, theme);
      const ok = /^#[0-9a-f]{6}$/.test(out) && cr(rgbOf(out), panel[theme]) >= 4.5;
      if (!ok) bad.push(`${theme} ${hex}→${out} ${/^#[0-9a-f]{6}$/.test(out) ? cr(rgbOf(out), panel[theme]).toFixed(2) : 'not opaque 6-digit'}`);
    }
    report('text palette: accessibleHex clears 4.5:1 AFTER rounding for 3/4/6/8-digit hex in both themes, always opaque',
      bad.length === 0, bad.length ? bad.join('; ') : `${cases.length * 2} cases ok`);
    report('text palette: non-hex input passes through untouched',
      WG.accessibleHex('sig', 'dark') === 'sig' && WG.accessibleHex('#12', 'dark') === '#12' && WG.accessibleHex('#12345', 'light') === '#12345');
    report('text palette: a color that already clears AA is returned unchanged (hue/value kept)',
      WG.accessibleHex('#b45309', 'light') === '#b45309' && WG.accessibleHex('#eab308', 'dark') === '#eab308',
      `${WG.accessibleHex('#b45309', 'light')} ${WG.accessibleHex('#eab308', 'dark')}`);
  }

  // ==== theme honored on the validation-failure path ========================
  {
    // the shipped must-fail demo: rejected by validateSpec (a pin-15/VCC role clash)
    const invalid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'specs', 'demo-pin15-vcc-wrong.json'), 'utf8'));
    const bad = renderCapture(invalid, { theme: 'light' });
    report('theme: a failing render requested as light gets .wg-light on a fresh mount (error box is themed)',
      !!bad.error && bad.error.name === 'WiringValidationError' && bad.mount.classList.contains('wg') && bad.mount.classList.contains('wg-light'),
      `error=${bad.error && bad.error.name} wg-light=${bad.mount.classList.contains('wg-light')}`);
    // one mount: valid light render, then a FAILING render asking for dark →
    // the stale .wg-light must be gone
    const mount = new FakeElement('div');
    const origErr = console.error; console.error = () => {};
    let err = null;
    try {
      WG.render({ board: { preset: 'perf', cols: 4, rows: 4 }, components: [], nets: [] }, mount, { theme: 'light' });
      const afterLight = mount.classList.contains('wg-light');
      try { WG.render(invalid, mount, { theme: 'dark' }); } catch (e) { err = e; }
      report('theme: a later failing render asking for dark clears a stale .wg-light from an earlier light render',
        afterLight === true && !!err && !mount.classList.contains('wg-light') && mount.classList.contains('wg'),
        `afterLight=${afterLight} err=${err && err.name} wg-light now=${mount.classList.contains('wg-light')}`);
    } finally { console.error = origErr; }
  }
}

module.exports = { run };

// ---- standalone entry ----
if (require.main === module) {
  let failures = 0;
  const report = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };
  run(report);
  console.log(failures ? `\n${failures} render failure(s)` : '\nall render checks passed');
  process.exit(failures ? 1 : 0);
}
