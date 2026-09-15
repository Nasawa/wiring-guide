/* wiring.js — declarative perfboard/stripboard wiring-guide renderer.
 * renderWiringGuide(spec, mountEl): draws an interactive SVG board + color-coded
 * components/wires + hover/click-linked wire table + legend + build order/checks,
 * all from a JSON spec. Vanilla JS + SVG, no build step, self-contained.
 * Board geometry comes from a `board.preset` (or an explicit grid).
 * spec.mode === "point-to-point" skips the board entirely and renders
 * direct pin→pin wiring — see docs/design/point-to-point-mode.md.
 * Semantic pin-role validation: components may bind to a physical header
 * pinout (e.g. "raspberry-pi-40") and nets carry an electrical role
 * (3V3/5V/POWER/GND/SIGNAL, declared or inferred from pin names); any
 * mismatch REFUSES to render (visible error box + throws
 * WiringValidationError). See docs/design/cant-be-wrong.md. */
(function (global) {
  'use strict';

  const PALETTE = {
    in:'#ef4444', node:'#f97316', gnd:'#3b82f6', sig:'#eab308', signal:'#eab308',
    r:'#b45309', res:'#b45309', d:'#10b981', diode:'#10b981', cap:'#06b6d4',
  };
  const col = c => (c && c[0] === '#') ? c : (PALETTE[c] || '#8b949e');

  // DRAWING palette vs TEXT palette. PALETTE above is tuned for 2.6–4 px
  // strokes on the board (WCAG only asks 3:1 of graphics) and stays as-is.
  // The same hexes used as 14 px TEXT — the inline net references inside build
  // steps — miss the 4.5:1 AA floor (resistor brown is 3.44:1 on the dark
  // panel; most tokens land 1.8–3.5:1 on the light panel). So inline text
  // references resolve through a per-theme CSS variable, `--tx-<token>`, whose
  // values are hand-picked to clear 4.5:1 against BOTH --bg and --panel of
  // their theme (checked in test/browser-smoke.js). Token aliases collapse to
  // one variable each so the two palettes can never drift per alias.
  const TX_TOKEN = { in: 'in', node: 'node', gnd: 'gnd', sig: 'sig', signal: 'sig', r: 'r', res: 'r', d: 'd', diode: 'd', cap: 'cap' };
  // Author-supplied hex colors have no themed twin, so they are nudged along
  // the lightness axis (lighter on dark, darker on light) just until they clear
  // 4.5:1 against the theme's panel — hue is kept so the reference still
  // "matches" its wire. Pure function of (hex, theme); deterministic.
  // Accepts #rgb / #rgba / #rrggbb / #rrggbbaa. A translucent color is first
  // composited over the theme panel (what the eye would see) and the result
  // is always an OPAQUE 6-digit hex — an alpha channel on a text color would
  // otherwise make the reference fade or vanish (#00000000 = invisible text).
  // The AA check runs on the ROUNDED 8-bit color at every step, because the
  // color that reaches CSS is the rounded one: checking the float and rounding
  // afterwards let e.g. #112 land on #81818a = 4.48:1.
  const THEME_PANEL = { dark: '#161b22', light: '#f6f8fa' };
  const parseHex = h => {
    const m = /^#([0-9a-f]{3,8})$/i.exec(h || ''); if (!m) return null;
    let s = m[1];
    if (s.length === 3 || s.length === 4) s = s.split('').map(c => c + c).join('');
    if (s.length !== 6 && s.length !== 8) return null;
    return { rgb: [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)), a: s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1 };
  };
  const hexRGB = h => parseHex(h).rgb;
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const clamp8 = rgb => rgb.map(v => Math.max(0, Math.min(255, Math.round(v))));
  const toHex = rgb => '#' + clamp8(rgb).map(v => v.toString(16).padStart(2, '0')).join('');
  function accessibleHex(hex, theme) {
    const p = parseHex(hex);
    if (!p) return hex;
    const light = theme === 'light', panel = hexRGB(THEME_PANEL[light ? 'light' : 'dark']);
    let rgb = p.rgb.map((v, k) => v * p.a + panel[k] * (1 - p.a)); // composite alpha over the panel
    const target = light ? [0, 0, 0] : [255, 255, 255];
    let out = clamp8(rgb);
    // 60 × 12% steps reach pure black/white (max contrast) in the worst case,
    // so the loop always terminates with an AA color.
    for (let i = 0; i < 60 && contrast(out, panel) < 4.5; i++) { rgb = rgb.map((v, k) => v + (target[k] - v) * 0.12); out = clamp8(rgb); }
    return toHex(out);
  }
  // CSS color for a net reference rendered as TEXT: themed variable for a
  // palette token, luminance-nudged hex for a custom color.
  const textCol = (c, theme) => (c && c[0] === '#') ? accessibleHex(c, theme) : `var(--tx-${TX_TOKEN[c] || 'sig'})`;

  // Colorblind-safe SECOND channel for wire roles. Color alone fails ~1 in 12
  // men (red/green being the worst pair — power `in` is red, diode `d` is green),
  // so each wire role also gets a distinct stroke DASH pattern. This is additive:
  // color is kept, the dash is layered on top. Keyed by the same palette token the
  // drawing/legend/tables already use. Component-kind tokens (resistor/diode/cap)
  // stay solid on purpose — their SHAPE (zig-zag body / cathode bar) already
  // encodes them without color. Patterns are chosen to stay legible at the wire
  // stroke widths (2.6–4 px) and to be mutually distinct even in pure monochrome:
  // solid vs dotted vs long-dash vs dash-dot.
  const ROLE_DASH = {
    in: '',                    // power / VCC — solid (the prominent supply line)
    gnd: '1.5,6',              // ground — dotted (round linecap → round dots)
    sig: '9,6', signal: '9,6', // signal — dashed
    node: '10,5,1.5,5',        // generic node tie — dash-dot
  };
  // dash pattern for a palette token, or '' (solid) for hex colors / unknown /
  // component-kind tokens.
  const dashOf = key => (key && key[0] !== '#' && ROLE_DASH[key]) ? ROLE_DASH[key] : '';
  // Human name for a role token — used to NAME the role in the wire <title>, so
  // the role survives even when BOTH color and dash pattern are stripped (screen
  // reader, monochrome print, image-off).
  const ROLE_NAME = {
    in: 'power', gnd: 'ground', sig: 'signal', signal: 'signal', node: 'node',
    r: 'resistor', res: 'resistor', d: 'diode', diode: 'diode', cap: 'capacitor',
  };
  // The palette token a net resolves to — mirrors the col() default-by-kind logic
  // so drawing, legend, title and table all agree on one key per net.
  const netKey = w => w.color || (w.kind === 'resistor' || w.kind === 'cap' ? 'r' : w.kind === 'diode' ? 'd' : 'sig');
  // Inline legend swatch: a short line segment carrying BOTH the color AND the
  // role's dash pattern (a solid box would show only the color channel).
  const swatchLine = key => {
    const d = dashOf(key), da = d ? ` stroke-dasharray="${d}"` : '';
    return `<svg class="swatch-line" width="30" height="12" viewBox="0 0 30 12" aria-hidden="true">` +
      `<line x1="1.5" y1="6" x2="28.5" y2="6" stroke="${col(key)}" stroke-width="3" stroke-linecap="round"${da}/></svg>`;
  };

  // A component pin is always an object. Keep the index with entries internally:
  // labels may repeat, while a `component.label` net reference deliberately picks
  // the first matching entry.
  const pinEntries = c => Array.isArray(c && c.pins) ? c.pins : [];
  const pinsOf = c => pinEntries(c).filter(p => p && typeof p === 'object').map(p => p.label).filter(label => typeof label === 'string');
  const positionedPinsOf = c => pinEntries(c).filter(p => p && typeof p === 'object').map(p => ({ label: p.label, loc: p.loc, notes: p.notes }));
  const pinEntryOf = (c, label) => pinEntries(c).find(p => p && typeof p === 'object' && p.label === label);
  const pinKey = (comp, index) => comp + '.' + index;

  // The themed root PAINTS its own --bg (and declares color-scheme so native
  // widgets/scrollbars match). A theme that only set text colors inherited the
  // host page's background, so the README embed on a plain white page rendered
  // #e6edf3 text on white — near-invisible. Owning the background is what
  // "fully themed" has to mean for an embeddable guide.
  const CSS = `
  .wg{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--panel:#161b22;--border:#30363d;--hole:#2d3340;
    --seg-fill:#1b2433;--seg-stroke:#33455f;--rail-fill:#10384a;--rail-stroke:#1f6f8b;
    --label:#cbd5e1;--outline:rgba(255,255,255,.22);--accent:#c084fc;
    --tx-in:#f87171;--tx-node:#fb923c;--tx-gnd:#60a5fa;--tx-sig:#facc15;--tx-r:#f59e0b;--tx-d:#34d399;--tx-cap:#22d3ee;
    color-scheme:dark;background:var(--bg);
    color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;
    container-type:inline-size;max-width:100%;}
  .wg.wg-light{--bg:#ffffff;--fg:#1f2328;--muted:#57606a;--panel:#f6f8fa;--border:#d0d7de;--hole:#eaeef2;
    --seg-fill:#eef2f6;--seg-stroke:#c3ccd6;--rail-fill:#dbeafe;--rail-stroke:#7ea8d8;
    --label:#3a4550;--outline:rgba(0,0,0,.28);--accent:#8250df;
    --tx-in:#b91c1c;--tx-node:#c2410c;--tx-gnd:#1d4ed8;--tx-sig:#854d0e;--tx-r:#9a3412;--tx-d:#047857;--tx-cap:#0e7490;
    color-scheme:light;}
  .wg,.wg *{box-sizing:border-box;}
  .wg h1{margin-top:0;color:var(--accent);letter-spacing:-.5px;}
  .wg h2{color:var(--accent);margin-top:28px;border-bottom:1px solid var(--border);padding-bottom:4px;}
  .wg .sub{color:var(--muted);}
  .wg .grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:24px;}
  /* Stack to one column when the CONTAINER (not the viewport) is narrow, so an
     embedded guide in a small element never overflows. Container query is the
     real fix; the media query stays as a fallback for full-page + old engines. */
  @container (max-width:800px){.wg .grid{grid-template-columns:minmax(0,1fr);}}
  @media(max-width:1150px){.wg .grid{grid-template-columns:minmax(0,1fr);}}
  .wg .sticky-board{position:sticky;top:8px;z-index:10;background:var(--bg);padding-bottom:8px;
    border-bottom:1px solid var(--border);margin-bottom:12px;}
  .wg svg{width:100%;height:auto;max-height:min(62vh,80cqw);background:var(--panel);border:1px solid var(--border);border-radius:8px;touch-action:none;cursor:grab;}
  .wg svg.panning{cursor:grabbing;}
  .wg svg:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .wg .hint{color:var(--muted);font-size:12px;margin:6px 0 0;}
  .wg .tbl-wrap{overflow-x:auto;max-width:100%;}
  .wg table{border-collapse:collapse;width:100%;font-size:13px;}
  .wg th,.wg td{padding:6px 8px;border:1px solid var(--border);text-align:left;}
  .wg th{background:var(--panel);}
  .wg td.sw{width:24px;padding:0;}
  .wg .swatch{display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:middle;border:1px solid rgba(255,255,255,.1);}
  /* Row highlight toggle: a REAL button (in the swatch cell, so the <tr> keeps
     its table semantics) sized to a 24px hit target around the 14px swatch. */
  .wg .rowbtn{display:block;width:24px;height:24px;padding:5px;margin:0;border:0;background:none;cursor:pointer;line-height:0;}
  .wg .rowbtn .swatch{display:block;}
  /* explicit size: beats the broad ".wg svg{width:100%}" board rule (2 classes > class+type) so the legend line stays a small swatch */
  .wg .swatch-line{width:30px;height:12px;vertical-align:middle;flex:0 0 auto;overflow:visible;}
  .wg .pin{font-family:ui-monospace,Menlo,monospace;font-size:12px;}
  .wg tr.wrow:hover{background:rgba(192,132,252,.07);}
  .wg tr.pinned{background:rgba(192,132,252,.15)!important;outline:1px solid #c084fc;}
  .wg .rowbtn:focus-visible,.wg .wref:focus-visible{outline:2px solid #c084fc;outline-offset:1px;}
  .wg .legend-row{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;}
  .wg details{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-top:14px;}
  .wg summary{cursor:pointer;color:var(--accent);font-weight:600;}
  .wg .warn{background:#7f1d1d;color:#fee2e2;padding:8px 12px;border-radius:6px;border-left:4px solid #ef4444;margin:10px 0;}
  .wg .ok{background:#14532d;color:#d1fae5;padding:8px 12px;border-radius:6px;border-left:4px solid #10b981;margin:10px 0;}
  .wg .note{background:var(--panel);color:var(--fg);padding:8px 12px;border-radius:6px;border-left:4px solid var(--accent);margin:10px 0;}
  .wg .step{background:var(--panel);border-left:3px solid #c084fc;padding:8px 12px;margin:6px 0;border-radius:4px;}
  /* Inline net reference inside a build step: a real <button> reset to read as
     inline text (color comes from the TEXT palette, set per element). */
  .wg .wref{font:inherit;font-weight:600;cursor:pointer;border:0;border-bottom:1px dotted currentColor;
    background:none;padding:0;margin:0;color:inherit;display:inline;line-height:inherit;border-radius:0;}
  .wg .hole{fill:var(--hole);}
  .wg .seg{fill:var(--seg-fill);stroke:var(--seg-stroke);stroke-width:1;}
  .wg .rail{fill:var(--rail-fill);stroke:var(--rail-stroke);stroke-width:1.5;}
  .wg .hlabel{font:600 7px monospace;text-anchor:middle;dominant-baseline:central;pointer-events:none;fill:var(--label);}
  .wg .glabel{fill:var(--muted);font:600 10px monospace;}
  .wg .comp-outline{fill:none;stroke:var(--outline);stroke-width:1;stroke-dasharray:3,2;}
  .wg .wire{stroke-width:2.6;fill:none;stroke-linecap:round;opacity:.85;}
  .wg .resistor{stroke-width:4;stroke-linecap:butt;fill:none;}
  .wg .diode{stroke-width:4;stroke-linecap:butt;fill:none;}
  .wg .hl{stroke:#c084fc!important;stroke-width:5!important;opacity:1!important;}
  .wg .p2p-comp{fill:var(--seg-fill);stroke:var(--seg-stroke);stroke-width:1.2;}
  .wg .p2p-pin{fill:var(--hole);stroke:var(--outline);stroke-width:1.5;}
  .wg .p2p-pinlabel{font:600 10px ui-monospace,Menlo,monospace;fill:var(--label);pointer-events:none;}
  .wg .p2p-badge{fill:var(--bg);stroke-width:2;}
  .wg .p2p-badgetext{font:700 10px ui-monospace,Menlo,monospace;fill:var(--fg);text-anchor:middle;dominant-baseline:central;pointer-events:none;}
  .wg tr.phase td{background:var(--panel);color:var(--accent);font-weight:600;}`;

  function injectCSS() {
    if (document.getElementById('wg-css')) return;
    const s = document.createElement('style');
    s.id = 'wg-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  // ---- board presets ----
  const PRESETS = {
    // ElectroCookie snappable strip board: rails are the OUTER column of each board,
    // field is horizontal 3-hole runs (5 per board-row). `boards` = grid arrangement:
    //   boards: 2          → 2 wide × 1 tall (horizontal, 4 rail lines)
    //   boards: {x:1, y:2} → 1 wide × 2 tall (vertical, 2 rail lines)
    //   boards: {x:2, y:2} → 2×2 grid
    'electrocookie-strip': (o) => {
      const b = o.boards, perW = 17, perH = 19;
      let nx, ny;
      if (b == null) { nx = 1; ny = 1; }
      else if (typeof b === 'number') { nx = b; ny = 1; }
      // { x, y } only (validateSpec rejects anything else); a missing axis is 1.
      else { nx = b.x != null ? b.x : 1; ny = b.y != null ? b.y : 1; }
      const cols = perW * nx, rows = perH * ny, rails = [], segments = [];
      const runs = [[2, 4], [5, 7], [8, 10], [11, 13], [14, 16]];
      for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
        const ox = bx * perW, oy = by * perH;
        rails.push({ col: ox + 1, r0: oy + 3, r1: oy + 17 });
        rails.push({ col: ox + 17, r0: oy + 3, r1: oy + 17 });
        for (let r = 1; r <= perH; r++)
          for (const [c0, c1] of runs) segments.push({ row: oy + r, c0: ox + c0, c1: ox + c1 });
      }
      return { cols, rows, rails, segments };
    },
    // Generic perfboard: every hole isolated (no buses). Override cols/rows.
    'perf': (o) => ({ cols: o.cols || 20, rows: o.rows || 20, rails: [], segments: [] }),
    // Common protoboard sizes (hole counts approximate per maker; override cols/rows).
    'perf-4x6cm': (o) => ({ cols: o.cols || 15, rows: o.rows || 24, rails: [], segments: [] }),
    'perf-5x7cm': (o) => ({ cols: o.cols || 18, rows: o.rows || 24, rails: [], segments: [] }),
    'perf-7x9cm': (o) => ({ cols: o.cols || 24, rows: o.rows || 36, rails: [], segments: [] }),

    // Solderless breadboards. Terminal strips = vertical 5-hole columns (rows a–e / f–j)
    // split by a center ravine; power rails run horizontally. `cols` overrides width.
    'breadboard-mini': (o) => bb(o.cols || 17, false),   // 170-pt: no power rails
    'breadboard-half': (o) => bb(o.cols || 30, true),    // 400-pt
    'breadboard-full': (o) => bb(o.cols || 63, true),    // 830-pt

    // Jumperless V5 — software-defined breadboard. Physically a half-breadboard
    // (30 five-hole terminal strips), but you route by NODE NUMBER in software,
    // not column+letter: each top strip is node 1–30, the strip directly across
    // the ravine is that column + 30 (nodes 31–60). Two adjustable rails
    // (TOP_RAIL / BOTTOM_RAIL) + GND. Geometry + node numbering come from the
    // manufacturer's documented node map — no board measurement needed. A
    // guide's whole value here is showing each strip's node number.
    'jumperless': (o) => jumperless(o.cols || 30),
    'jumperless-v5': (o) => jumperless(o.cols || 30),
  };

  // breadboard geometry builder
  function bb(cols, rails) {
    const segments = [], railList = [];
    if (rails) {
      // rows: 1,2 top rails · 4–8 a–e · 9 ravine · 10–14 f–j · 16,17 bottom rails
      for (let c = 1; c <= cols; c++) { segments.push({ col: c, r0: 4, r1: 8 }); segments.push({ col: c, r0: 10, r1: 14 }); }
      railList.push({ row: 1, c0: 1, c1: cols, label: '−' }, { row: 2, c0: 1, c1: cols, label: '+' },
                    { row: 16, c0: 1, c1: cols, label: '+' }, { row: 17, c0: 1, c1: cols, label: '−' });
      return { cols, rows: 17, rails: railList, segments };
    }
    // mini: a–e rows 1–5 · ravine row 6 · f–j rows 7–11
    for (let c = 1; c <= cols; c++) { segments.push({ col: c, r0: 1, r1: 5 }); segments.push({ col: c, r0: 7, r1: 11 }); }
    return { cols, rows: 11, rails: [], segments };
  }

  // Jumperless V5 geometry: 30 five-hole terminal strips per half, split by a
  // center ravine. The routing identifier is the NODE NUMBER: top strip of
  // column c = node c (1–30); the strip across the ravine = node c + 30 (31–60).
  // So we suppress the generic numeric axes and stamp each strip with its node
  // number instead (nodeLabels). Rails follow the standard breadboard 2-line
  // layout; on the Jumperless the adjustable rail lines are TOP_RAIL / BOTTOM_RAIL
  // and the companion line is GND (bottom rail is often used as GND).
  function jumperless(cols) {
    const segments = [], nodeLabels = [];
    for (let c = 1; c <= cols; c++) {
      segments.push({ col: c, r0: 4, r1: 8 });    // top strip    → node c
      segments.push({ col: c, r0: 10, r1: 14 });  // bottom strip → node c + cols
      nodeLabels.push({ col: c, row: 3, text: c });          // above top strip
      nodeLabels.push({ col: c, row: 15, text: c + cols });  // below bottom strip
    }
    const rails = [
      { row: 1, c0: 1, c1: cols, label: 'TOP_RAIL' },
      { row: 2, c0: 1, c1: cols, label: 'GND' },
      { row: 16, c0: 1, c1: cols, label: 'BOTTOM_RAIL' },
      { row: 17, c0: 1, c1: cols, label: 'GND' },
    ];
    return { cols, rows: 17, rails, segments, nodeLabels, noColAxis: true, noRowAxis: true };
  }

  // Sanity caps on the resolved grid: per axis AND total holes (each hole is a
  // <circle>; a million of them is a hung tab, not a wiring guide). 20 000
  // holes is ~15× the biggest shipped board (electrocookie 2×2 = 1292).
  const MAX_BOARD_DIM = 1000, MAX_BOARD_HOLES = 20000;
  // Identifier grammar for component + net ids. They are interpolated into
  // attribute selectors ([data-id="…"]), \b-bounded regexes (build-step refs),
  // and "component.pin" endpoint strings (split at the FIRST dot), so they must
  // be plain: start alphanumeric, then letters/digits/_/-. Strings only.
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const ID_RULE = 'a non-empty string of letters, digits, "_" or "-", starting with a letter or digit';
  const knownPreset = name => Object.prototype.hasOwnProperty.call(PRESETS, name);

  function resolveBoard(board) {
    if (board && board.preset && knownPreset(board.preset)) {
      const g = PRESETS[board.preset](board);
      return Object.assign(g, { rails: board.rails || g.rails, segments: board.segments || g.segments });
    }
    // explicit grid
    return {
      cols: board.cols || 20, rows: board.rows || 20,
      rails: board.rails || [], segments: board.segments || [],
    };
  }

  // ---- svg helpers ----
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const el = (t, a, html) => { const e = document.createElement(t); if (a) for (const k in a) e.setAttribute(k, a[k]); if (html != null) e.innerHTML = html; return e; };

  function attachPanZoom(svg) {
    if (typeof svg.getAttribute !== 'function') return;
    const initial = svg.getAttribute('viewBox');
    const initialVB = initial.trim().split(/\s+/).map(Number);
    const minW = initialVB[2] / 8, maxW = initialVB[2] * 4;
    const pointers = new Map();
    let pan = null, pinch = null;

    const readVB = () => {
      const v = svg.getAttribute('viewBox').trim().split(/\s+/).map(Number);
      return { x: v[0], y: v[1], w: v[2], h: v[3] };
    };
    const writeVB = (v) => svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const clampW = w => Math.max(minW, Math.min(maxW, w));
    const userPoint = (x, y) => {
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const p = svg.createSVGPoint(); p.x = x; p.y = y;
      return p.matrixTransform(ctm.inverse());
    };
    const zoomAt = (x, y, factor) => {
      const u = userPoint(x, y);
      if (!u) return;
      const vb = readVB(), newW = clampW(vb.w * factor), newH = vb.h * (newW / vb.w);
      writeVB({
        x: u.x - (u.x - vb.x) * (newW / vb.w),
        y: u.y - (u.y - vb.y) * (newH / vb.h), w: newW, h: newH,
      });
    };
    const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const pointMidpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const startPan = (p, vb) => { pan = { x: p.x, y: p.y, vb }; svg.classList.add('panning'); };
    const resetPan = () => { pan = null; svg.classList.remove('panning'); };

    svg.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 / 1.1 : 1.1);
    }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      svg.setPointerCapture(e.pointerId);
      if (pointers.size === 1) startPan(pointers.get(e.pointerId), readVB());
      else if (pointers.size === 2) {
        resetPan();
        const ps = [...pointers.values()];
        pinch = { a: { ...ps[0] }, b: { ...ps[1] } };
      }
    });
    svg.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      e.preventDefault();
      const previous = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const ids = [...pointers.keys()], current = ids.map(id => pointers.get(id));
        const old = pinch || { a: previous, b: current[1] };
        const next = { a: current[0], b: current[1] };
        const oldDistance = pointDistance(old.a, old.b), newDistance = pointDistance(next.a, next.b);
        if (oldDistance > 0 && newDistance > 0) {
          const midpoint = pointMidpoint(next.a, next.b);
          zoomAt(midpoint.x, midpoint.y, oldDistance / newDistance);
        }
        pinch = { a: { ...next.a }, b: { ...next.b } };
      } else if (pointers.size === 1 && pan) {
        const start = pan.vb, vb = readVB(), w = svg.clientWidth, h = svg.clientHeight;
        if (!w || !h) return;
        writeVB({
          x: start.x - (e.clientX - pan.x) * (vb.w / w),
          y: start.y - (e.clientY - pan.y) * (vb.h / h), w: vb.w, h: vb.h,
        });
      }
    });
    const endPointer = e => {
      e.preventDefault();
      pointers.delete(e.pointerId);
      if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        const p = [...pointers.values()][0]; startPan(p, readVB());
      } else resetPan();
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('dblclick', e => { e.preventDefault(); svg.setAttribute('viewBox', initial); });

    // ---- keyboard pan/zoom (a11y: the pointer/wheel gestures above are unusable
    // without a mouse/touch) --------------------------------------------------
    // The SVG takes focus (tabindex=0) and the same viewBox transform the pointer
    // path drives is now reachable from the keyboard: arrows pan (Shift = coarse),
    // + / - zoom about the CENTER, 0 resets — mirroring the double-click reset.
    // zoomCenter is CTM-free (unlike the pointer zoomAt, which needs a live screen
    // matrix) so it works headless and keeps the viewBox center fixed while zooming.
    const zoomCenter = factor => {
      const vb = readVB(), newW = clampW(vb.w * factor), newH = vb.h * (newW / vb.w);
      writeVB({ x: vb.x + (vb.w - newW) / 2, y: vb.y + (vb.h - newH) / 2, w: newW, h: newH });
    };
    const PAN_STEP = 0.15; // fraction of the visible viewBox per arrow press
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Plus Minus 0');
    svg.addEventListener('keydown', e => {
      const vb = readVB();
      const step = (e.shiftKey ? 2.5 : 1) * PAN_STEP;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft':  writeVB({ x: vb.x - vb.w * step, y: vb.y, w: vb.w, h: vb.h }); break;
        case 'ArrowRight': writeVB({ x: vb.x + vb.w * step, y: vb.y, w: vb.w, h: vb.h }); break;
        case 'ArrowUp':    writeVB({ x: vb.x, y: vb.y - vb.h * step, w: vb.w, h: vb.h }); break;
        case 'ArrowDown':  writeVB({ x: vb.x, y: vb.y + vb.h * step, w: vb.w, h: vb.h }); break;
        case '+': case '=': zoomCenter(1 / 1.2); break; // '=' is unshifted '+'
        case '-': case '_': zoomCenter(1.2); break;
        case '0': svg.setAttribute('viewBox', initial); break; // reset, like dblclick
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });
  }
  // Wrap a table so it scrolls horizontally inside a too-narrow container
  // instead of forcing the whole guide to overflow (embeddability).
  const scrollWrap = t => { const d = el('div', { class: 'tbl-wrap' }); d.appendChild(t); return d; };
  // Render options — all orthogonal, all defaulting to today's behavior. Resolved
  // as defaults ← spec.options ← the render() opts arg (arg wins), so a spec can
  // carry display prefs and a caller can still override per render.
  const OPT_DEFAULTS = { pinTables: true, legend: true, buildOrder: true, checks: true, drc: true, hints: true, theme: 'dark' };
  const resolveOpts = (spec, opts) => Object.assign({}, OPT_DEFAULTS, (spec && spec.options) || {}, opts || {});

  function zig(ax, ay, bx, by) {
    const n = 6, dx = (bx - ax) / n, dy = (by - ay) / n, horiz = Math.abs(by - ay) < Math.abs(bx - ax);
    let d = `M${ax},${ay}`;
    for (let i = 1; i < n; i++) { const px = ax + dx * i, py = ay + dy * i, of = (i % 2 ? 7 : -7); d += ` L${px + (horiz ? 0 : of)},${py + (horiz ? of : 0)}`; }
    return d + ` L${bx},${by}`;
  }

  /* ---- can't-be-wrong: header pinout maps + semantic pin-role validation ----
   * (see docs/design/cant-be-wrong.md)
   *
   * A `pinout` on a component binds its pins to PHYSICAL positions on a known
   * header. A net's electrical role (3V3/5V/POWER/GND/SIGNAL) is declared
   * (`role` on the net, `pinRoles` on a component) or inferred from pin names
   * (VCC/3V3/5V/GND…). validateSpec() cross-checks intent against the physical
   * pinout; ANY mismatch is a hard error — renderWiringGuide mounts a visible
   * "validation failed" box, draws nothing, and throws WiringValidationError.
   *
   * Motivated by a classic wiring mistake: a sensor's VCC spec'd onto Pi
   * physical pin 15 (GPIO22) instead of pin 17 (3V3); the sensor browns out
   * at ~1.5 V and looks dead. A geometry-only renderer happily draws it
   * anyway. This validation exists so the spec cannot render a lie.
   *
   * Validation is OPT-IN per spec: with no `pinout` and no `role`/`pinRoles`
   * anywhere, validateSpec finds nothing to check and old specs render as
   * before. */

  /* PROVENANCE. Every built-in pinout carries `source` — ONE clean URL to the
   * primary document it was checked against (vendor datasheet / official docs,
   * not a fan wiki) — and a `verified` date, IN THE TREE, so the citation
   * survives a history-free re-publish. Anything derived or explanatory lives in
   * the comment beside the map, never inside `source`.
   *
   * Power pins are classified per that document (see fnClass). This is COARSE
   * role checking, not electrical validation: it stops a regulated 3V3/5V rail
   * from being wired to a board's RAW regulator input (VIN/VSYS) and stops a
   * supply from being wired to a voltage-REFERENCE pin (AREF/IOREF/ADC_VREF).
   * It does not know voltages, directions or current limits — the author owns
   * those. */
  const PINOUTS = {
    // Raspberry Pi 40-pin GPIO header (J8) — physical pin number → function.
    // Identical on every 40-pin Pi (Zero/Zero 2/2/3/4/5). Cross-checked against
    // pinout.xyz (secondary).
    'raspberry-pi-40': {
      label: 'Raspberry Pi 40-pin GPIO header (J8)',
      source: 'https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio',
      verified: '2026-09-14',
      pins: {
        1: '3V3',            2: '5V',
        3: 'GPIO2/SDA1',     4: '5V',
        5: 'GPIO3/SCL1',     6: 'GND',
        7: 'GPIO4/GPCLK0',   8: 'GPIO14/TXD0',
        9: 'GND',           10: 'GPIO15/RXD0',
       11: 'GPIO17',        12: 'GPIO18/PCM_CLK',
       13: 'GPIO27',        14: 'GND',
       15: 'GPIO22',        16: 'GPIO23',
       17: '3V3',           18: 'GPIO24',
       19: 'GPIO10/MOSI',   20: 'GND',
       21: 'GPIO9/MISO',    22: 'GPIO25',
       23: 'GPIO11/SCLK',   24: 'GPIO8/CE0',
       25: 'GND',           26: 'GPIO7/CE1',
       27: 'ID_SD',         28: 'ID_SC',
       29: 'GPIO5',         30: 'GND',
       31: 'GPIO6',         32: 'GPIO12/PWM0',
       33: 'GPIO13/PWM1',   34: 'GND',
       35: 'GPIO19/PCM_FS', 36: 'GPIO16',
       37: 'GPIO26',        38: 'GPIO20/PCM_DIN',
       39: 'GND',           40: 'GPIO21/PCM_DOUT',
      },
    },
    // Raspberry Pi Pico 40-pin header — physical pin number → function. Per the
    // Raspberry Pi docs the pinout is the same for Pico, Pico H, Pico 2 and
    // Pico 2 (with headers); the WIRELESS boards (Pico W / WH / 2 W) differ, so
    // don't use this map for them (pico-series doc:
    // https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html).
    // Power pins per the Pico datasheet §"Pinout": VBUS = "the micro-USB input
    // voltage" (5V class); VSYS = "the main system input voltage" feeding the
    // buck-boost SMPS (RAW class — not a regulated rail); 3V3(OUT) = the
    // regulated 3V3 rail the SMPS generates; 3V3_EN = SMPS enable (control,
    // not power); ADC_VREF = "the ADC power supply (and reference) voltage"
    // (REF class); RUN = RP2040 enable/reset (signal). No numeric windows are
    // claimed here — see the datasheet.
    'raspberry-pi-pico': {
      label: 'Raspberry Pi Pico 40-pin header',
      source: 'https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf',
      verified: '2026-09-14',
      pins: {
        1: 'GP0',          2: 'GP1',
        3: 'GND',          4: 'GP2',
        5: 'GP3',          6: 'GP4',
        7: 'GP5',          8: 'GND',
        9: 'GP6',         10: 'GP7',
       11: 'GP8',         12: 'GP9',
       13: 'GND',         14: 'GP10',
       15: 'GP11',        16: 'GP12',
       17: 'GP13',        18: 'GND',
       19: 'GP14',        20: 'GP15',
       21: 'GP16',        22: 'GP17',
       23: 'GND',         24: 'GP18',
       25: 'GP19',        26: 'GP20',
       27: 'GP21',        28: 'GND',
       29: 'GP22',        30: 'RUN',
       31: 'GP26/ADC0',   32: 'GP27/ADC1',
       33: 'AGND',        34: 'GP28/ADC2',
       35: 'ADC_VREF',    36: '3V3(OUT)',
       37: '3V3_EN',      38: 'GND',
       39: 'VSYS',        40: 'VBUS',
      },
    },
    // ---- LABEL-ADDRESSED boards (addressing:'label') --------------------------
    // Arduino / ESP boards aren't referenced by physical pin number — you use the
    // SILKSCREEN LABEL (D13, A0, GPIO4, 5V). So `pins` is keyed by label, and a
    // key may list "/"-separated ALIASES: any of them resolves the pin (e.g.
    // "D2/GPIO4" is reachable as "D2", "GPIO4", or "D2/GPIO4"). The function
    // string carries role tokens (5V/3V3 = regulated rails, GND = ground, VIN =
    // raw regulator input, AREF/IOREF = reference; RESERVED = never wire to it;
    // everything else is a signal). Each map cites its datasheet in `source`.
    //
    // Arduino Uno R3 (datasheet A000066): VIN is the "Voltage Input" feeding the
    // on-board 5V LDO (U1 = SPX1117M3-L-5), NOT the 5V rail — a regulated rail
    // wired into it under-feeds that regulator (RAW class; no numeric window is
    // claimed here, see the datasheet). IOREF = "Reference for digital logic V -
    // connected to 5V" (a reference for shields to sense, not a supply); AREF =
    // "Analog reference voltage" (an input). Both are REF class.
    'arduino-uno-r3': {
      label: 'Arduino Uno R3 (ATmega328P)', addressing: 'label',
      source: 'https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf',
      verified: '2026-09-14',
      pins: {
        'D0/RX': 'GPIO/UART-RX', 'D1/TX': 'GPIO/UART-TX', 'D2': 'GPIO', 'D3': 'GPIO/PWM',
        'D4': 'GPIO', 'D5': 'GPIO/PWM', 'D6': 'GPIO/PWM', 'D7': 'GPIO', 'D8': 'GPIO',
        'D9': 'GPIO/PWM', 'D10': 'GPIO/PWM/SPI-SS', 'D11': 'GPIO/PWM/SPI-MOSI',
        'D12': 'GPIO/SPI-MISO', 'D13': 'GPIO/SPI-SCK/LED',
        'A0': 'ADC', 'A1': 'ADC', 'A2': 'ADC', 'A3': 'ADC', 'A4': 'ADC/I2C-SDA', 'A5': 'ADC/I2C-SCL',
        '5V': '5V', '3V3': '3V3', 'GND': 'GND', 'VIN': 'VIN', 'IOREF': 'IOREF', 'RESET': 'RESET', 'AREF': 'AREF',
      },
    },
    // Arduino Nano (datasheet A000005): VIN (pin 30) is the unregulated external
    // supply input feeding the on-board 5V LDO — NOT the 5V rail (RAW class; no
    // numeric window is claimed here, see the datasheet). AREF is the analog
    // reference input (REF class). No IOREF pin.
    'arduino-nano-v3': {
      label: 'Arduino Nano v3 (ATmega328P)', addressing: 'label',
      source: 'https://docs.arduino.cc/resources/datasheets/A000005-datasheet.pdf',
      verified: '2026-09-14',
      pins: {
        'D0/RX': 'GPIO/UART-RX', 'D1/TX': 'GPIO/UART-TX', 'D2': 'GPIO', 'D3': 'GPIO/PWM',
        'D4': 'GPIO', 'D5': 'GPIO/PWM', 'D6': 'GPIO/PWM', 'D7': 'GPIO', 'D8': 'GPIO',
        'D9': 'GPIO/PWM', 'D10': 'GPIO/PWM/SPI-SS', 'D11': 'GPIO/PWM/SPI-MOSI',
        'D12': 'GPIO/SPI-MISO', 'D13': 'GPIO/SPI-SCK/LED',
        'A0': 'ADC', 'A1': 'ADC', 'A2': 'ADC', 'A3': 'ADC', 'A4': 'ADC/I2C-SDA', 'A5': 'ADC/I2C-SCL',
        'A6': 'ADC-ONLY', 'A7': 'ADC-ONLY',
        '5V': '5V', '3V3': '3V3', 'GND': 'GND', 'VIN': 'VIN', 'RESET': 'RESET', 'AREF': 'AREF',
      },
    },
    // ESP32-DevKitC V4: "5V — 5 V power supply", "3V3 — 3.3 V power supply",
    // "EN — CHIP_PU, Reset"; GPIO6–11 (CLK/D0–D3/CMD) are the SPI-flash lines
    // Espressif says to avoid. Power options: USB, or 5V+GND, or 3V3+GND pins.
    'esp32-devkitc-38pin': {
      label: 'ESP32 DevKitC V4 (ESP32-WROOM-32, 38-pin)', addressing: 'label',
      source: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html',
      verified: '2026-09-14',
      pins: {
        '3V3': '3V3', '5V': '5V', 'GND': 'GND', 'EN': 'EN',
        'VP/GPIO36': 'ADC/INPUT-ONLY', 'VN/GPIO39': 'ADC/INPUT-ONLY',
        'GPIO34': 'ADC/INPUT-ONLY', 'GPIO35': 'ADC/INPUT-ONLY',
        'GPIO32': 'GPIO/ADC', 'GPIO33': 'GPIO/ADC', 'GPIO25': 'GPIO/ADC/DAC1', 'GPIO26': 'GPIO/ADC/DAC2',
        'GPIO27': 'GPIO/ADC', 'GPIO14': 'GPIO/ADC', 'GPIO12': 'GPIO/ADC/STRAPPING', 'GPIO13': 'GPIO/ADC',
        'GPIO23': 'GPIO/SPI-MOSI', 'GPIO22': 'GPIO/I2C-SCL', 'TX0/GPIO1': 'GPIO/UART-TX', 'RX0/GPIO3': 'GPIO/UART-RX',
        'GPIO21': 'GPIO/I2C-SDA', 'GPIO19': 'GPIO/SPI-MISO', 'GPIO18': 'GPIO/SPI-SCK', 'GPIO5': 'GPIO/SPI-CS/STRAPPING',
        'GPIO17': 'GPIO', 'GPIO16': 'GPIO', 'GPIO4': 'GPIO/ADC', 'GPIO0': 'GPIO/STRAPPING/BOOT',
        'GPIO2': 'GPIO/ADC/STRAPPING', 'GPIO15': 'GPIO/ADC/STRAPPING',
        'GPIO6': 'RESERVED-FLASH', 'GPIO7': 'RESERVED-FLASH', 'GPIO8': 'RESERVED-FLASH',
        'GPIO9': 'RESERVED-FLASH', 'GPIO10': 'RESERVED-FLASH', 'GPIO11': 'RESERVED-FLASH',
      },
    },
    // NodeMCU DevKit v1.0 (open hardware; schematic NODEMCU_DEVKIT_V1.0.PDF in
    // the cited repo): the VIN header pin is the VDD5V node feeding the
    // NCP1117-3.3 LDO (U4) — a raw regulator input (RAW class), not the 3.3 V
    // rail. The vendor states no input-voltage window, so none is claimed here.
    'esp8266-nodemcu-v1': {
      label: 'ESP8266 NodeMCU v1.0 (ESP-12E)', addressing: 'label',
      source: 'https://github.com/nodemcu/nodemcu-devkit-v1.0',
      verified: '2026-09-14',
      pins: {
        'D0/GPIO16': 'GPIO/WAKE', 'D1/GPIO5': 'GPIO/I2C-SCL', 'D2/GPIO4': 'GPIO/I2C-SDA',
        'D3/GPIO0': 'GPIO/STRAPPING-FLASH', 'D4/GPIO2': 'GPIO/STRAPPING-LED', 'D5/GPIO14': 'GPIO/SPI-SCK',
        'D6/GPIO12': 'GPIO/SPI-MISO', 'D7/GPIO13': 'GPIO/SPI-MOSI', 'D8/GPIO15': 'GPIO/SPI-CS/STRAPPING',
        'RX/GPIO3': 'GPIO/UART-RX', 'TX/GPIO1': 'GPIO/UART-TX', 'A0': 'ADC',
        '3V3': '3V3', 'VIN': 'VIN', 'GND': 'GND', 'EN': 'EN', 'RST': 'RST',
      },
    },
    // LOLIN/WEMOS D1 mini: labelled 5V (USB-side 5 V feeding the 3.3 V LDO) and
    // 3V3 (regulated rail); D0–D8 GPIO mapping per the LOLIN pin diagram.
    'wemos-d1-mini': {
      label: 'WEMOS/LOLIN D1 mini (ESP8266EX, ESP-12F)', addressing: 'label',
      source: 'https://www.wemos.cc/en/latest/d1/d1_mini.html',
      verified: '2026-09-14',
      pins: {
        'D0/GPIO16': 'GPIO/WAKE', 'D1/GPIO5': 'GPIO/I2C-SCL', 'D2/GPIO4': 'GPIO/I2C-SDA',
        'D3/GPIO0': 'GPIO/STRAPPING-FLASH', 'D4/GPIO2': 'GPIO/STRAPPING-LED', 'D5/GPIO14': 'GPIO/SPI-SCK',
        'D6/GPIO12': 'GPIO/SPI-MISO', 'D7/GPIO13': 'GPIO/SPI-MOSI', 'D8/GPIO15': 'GPIO/SPI-CS/STRAPPING',
        'RX/GPIO3': 'GPIO/UART-RX', 'TX/GPIO1': 'GPIO/UART-TX', 'A0': 'ADC',
        '3V3': '3V3', '5V': '5V', 'GND': 'GND', 'RST': 'RST',
      },
    },
  };

  /* ---- common breakout MODULES (phase-2 content) --------------------------
   * A discrete sensor/peripheral board (HC-SR04, DHT22, SSD1306…) is not a
   * pin-numbered HEADER like the boards above — it is a 3–6-pin part addressed
   * by silkscreen label with a fixed electrical role per pin. So instead of the
   * heavy `pinout` model, a component references one by `module` and gets its
   * canonical pin LABELS + per-pin ROLES for free: the validator then catches a
   * power pin wired to a signal (etc.) with zero hand-annotation. VCC is POWER
   * (accepts 3V3 or 5V) unless a part demands one rail; every data/clock line is
   * SIGNAL. Author-supplied `pins` (e.g. to add board `loc`s) and `pinRoles`
   * always win over the module defaults. Roles feed the same role-agreement
   * machinery `pinRoles` already uses — no new validation path. */
  const MODULES = {
    'hc-sr04': { label: 'HC-SR04 ultrasonic ranger', pins: [
      { label: 'VCC', role: '5V', notes: 'Needs a solid 5V supply.' },
      { label: 'TRIG', role: 'SIGNAL', notes: 'Trigger input — a 10µs HIGH pulse starts a ping.' },
      { label: 'ECHO', role: 'SIGNAL', notes: 'Echo output is 5V logic — divide/level-shift for a 3.3V MCU.' },
      { label: 'GND', role: 'GND' },
    ] },
    'dht22': { label: 'DHT22 / AM2302 temp + humidity', pins: [
      { label: 'VCC', role: 'POWER', notes: '3.3–6V.' },
      { label: 'DATA', role: 'SIGNAL', notes: 'Single-wire bus — 4.7–10kΩ pull-up to VCC.' },
      { label: 'GND', role: 'GND' },
    ] },
    'dht11': { label: 'DHT11 temp + humidity', pins: [
      { label: 'VCC', role: 'POWER', notes: '3–5.5V.' },
      { label: 'DATA', role: 'SIGNAL', notes: 'Single-wire bus — 4.7–10kΩ pull-up to VCC.' },
      { label: 'GND', role: 'GND' },
    ] },
    'ds18b20': { label: 'DS18B20 1-Wire temperature', pins: [
      { label: 'VCC', role: 'POWER', notes: '3.0–5.5V.' },
      { label: 'DATA', role: 'SIGNAL', notes: '1-Wire bus — 4.7kΩ pull-up to VCC.' },
      { label: 'GND', role: 'GND' },
    ] },
    'mpu6050': { label: 'MPU-6050 6-axis IMU (I²C)', pins: [
      { label: 'VCC', role: 'POWER', notes: 'On-board regulator: 3–5V.' },
      { label: 'GND', role: 'GND' },
      { label: 'SCL', role: 'SIGNAL', notes: 'I²C clock.' },
      { label: 'SDA', role: 'SIGNAL', notes: 'I²C data.' },
      { label: 'XDA', role: 'SIGNAL', notes: 'Auxiliary I²C data — usually left open.' },
      { label: 'XCL', role: 'SIGNAL', notes: 'Auxiliary I²C clock — usually left open.' },
      { label: 'AD0', role: 'SIGNAL', notes: 'Address select: low → 0x68, high → 0x69.' },
      { label: 'INT', role: 'SIGNAL', notes: 'Interrupt output — optional.' },
    ] },
    'ssd1306-oled': { label: 'SSD1306 OLED (I²C, 4-pin)', pins: [
      { label: 'GND', role: 'GND' },
      { label: 'VCC', role: 'POWER', notes: 'Most 4-pin modules are 3.3–5V tolerant.' },
      { label: 'SCL', role: 'SIGNAL', notes: 'I²C clock.' },
      { label: 'SDA', role: 'SIGNAL', notes: 'I²C data.' },
    ] },
    'bme280': { label: 'BME280 pressure/temp/humidity (I²C, 4-pin)', pins: [
      { label: 'VCC', role: 'POWER', notes: '3.3–5V on a regulated breakout (bare sensor is 3.3V only).' },
      { label: 'GND', role: 'GND' },
      { label: 'SCL', role: 'SIGNAL', notes: 'I²C clock (silkscreened SCK on some boards).' },
      { label: 'SDA', role: 'SIGNAL', notes: 'I²C data (silkscreened SDI on some boards).' },
    ] },
    'pn532-i2c': { label: 'PN532 NFC/RFID (I²C mode)', pins: [
      { label: 'VCC', role: 'POWER', notes: '3.3–5V. Set the on-board DIP switches to I²C mode.' },
      { label: 'GND', role: 'GND' },
      { label: 'SDA', role: 'SIGNAL', notes: 'I²C data.' },
      { label: 'SCL', role: 'SIGNAL', notes: 'I²C clock.' },
    ] },
  };
  // Friendly aliases → canonical module id.
  const MODULE_ALIASES = { 'am2302': 'dht22', 'ssd1306': 'ssd1306-oled', 'pn532': 'pn532-i2c' };
  const resolveModule = id => MODULES[id] || MODULES[MODULE_ALIASES[id]] || null;

  // Expand a `module` reference into concrete pins + pinRoles. Idempotent:
  // once expanded the component carries its own `pins`, so a second pass is a
  // no-op. Author `pins`/`pinRoles`/`label` win over the module's defaults.
  function expandModule(c) {
    if (!c || c.module == null) return c;
    const m = resolveModule(c.module);
    if (!m) return c; // unknown id — validateSpec reports it with the known list
    const out = Object.assign({}, c);
    if (out.label == null) out.label = m.label;
    if (!Array.isArray(c.pins)) out.pins = m.pins.map(p => ({ label: p.label, notes: p.notes }));
    const roles = {};
    m.pins.forEach(p => { if (p.role) roles[p.label] = p.role; });
    out.pinRoles = Object.assign(roles, c.pinRoles || {});
    return out;
  }
  // Return a spec whose module-referencing components are expanded. Cheap no-op
  // when no component uses `module`, so every entry point can call it blindly.
  function normalizeSpec(spec) {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.components)) return spec;
    if (!spec.components.some(c => c && c.module != null)) return spec;
    return Object.assign({}, spec, { components: spec.components.map(expandModule) });
  }

  // Electrical roles. POWER = "some supply rail" (accepts 3V3 or 5V); use the
  // specific one when you know it. Values are the pinout classes each role may
  // land on. Two pin classes appear in NO list on purpose: RAW (a board's
  // regulator input — VIN/VSYS) and REF (a voltage-reference pin — AREF/IOREF/
  // ADC_VREF). Any net with a resolved role is refused there: a regulated rail
  // does not belong on a raw input, and a supply does not belong on a
  // reference. A net with no resolved role (e.g. a battery "+" to VIN) is
  // not checked — this is coarse role checking, and the author owns the goal.
  const ROLE_OK = { '3V3': ['3V3'], '5V': ['5V'], 'POWER': ['3V3', '5V'], 'GND': ['GND'], 'SIGNAL': ['SIGNAL'] };
  // pin-name tokens → inferred role (checked in this priority order). "VIN" is
  // deliberately NOT a POWER token: on a board it is the raw regulator input
  // and on a breakout it may be either — inferring "3V3-or-5V rail" from it is
  // the very mistake the RAW class exists to catch. Name it and it stays unchecked.
  const ROLE_TOKENS = [
    ['3V3',   /^(3V3|3\.3V?)$/i],
    ['5V',    /^(5V|VBUS)$/i],
    ['GND',   /^(GND|AGND|DGND|GNDA|GNDD|0V|V-)$/i],
    ['POWER', /^(VCC|VDD|V\+|PWR|POWER)$/i],
  ];
  // Split a pin name into identifiers. "_" is PART of an identifier (same
  // exact-name stance as fnClass): "P1 3V3" → 3V3 infers a rail, but "3V3_EN",
  // "VBUS_SENSE" and "VCC_EN" are single names that infer nothing — a control
  // or sense line must never be mistaken for the supply it is named after.
  const tokensOf = s => String(s).split(/[^A-Za-z0-9.+\-_]+/).filter(Boolean);
  function roleFromName(name) {
    const toks = tokensOf(name);
    for (const [role, re] of ROLE_TOKENS) if (toks.some(t => re.test(t))) return role;
    return null;
  }
  // pinout function string → role class. A function string is one or more
  // "/"-separated names, each optionally annotated "(…)" ("3V3(OUT)",
  // "GPIO2/SDA1"). Names are matched EXACTLY against small vocabularies — no
  // prefix guessing, so a custom "VBUS_SENSE" is a signal, not the 5V rail:
  //   GND   ground (GND/AGND/DGND…)      3V3 / 5V  regulated rails (VBUS = USB 5 V)
  //   RAW   the board's own regulator INPUT (VIN, VSYS) — not a rail
  //   REF   a voltage-reference pin (AREF, IOREF, VREF, ADC_VREF) — not a supply
  //   RESERVED  ID_* or anything containing RESERVED — never wire to it
  // 3V3_EN is a control signal, not power, and falls through to SIGNAL.
  const FN_CLASS = {
    GND: 'GND', AGND: 'GND', DGND: 'GND', GNDA: 'GND', GNDD: 'GND',
    '3V3': '3V3', '3.3V': '3V3', '5V': '5V', VBUS: '5V',
    VIN: 'RAW', VSYS: 'RAW',
    AREF: 'REF', IOREF: 'REF', VREF: 'REF', ADC_VREF: 'REF',
  };
  const CLASS_ORDER = ['GND', 'REF', '3V3', '5V', 'RAW'];
  const fnClass = fn => {
    const s = String(fn).toUpperCase();
    if (/^ID_|RESERVED/.test(s)) return 'RESERVED';
    const names = s.split('/').map(t => t.replace(/\(.*$/, '').trim());
    const found = names.map(n => FN_CLASS[n]).filter(Boolean);
    for (const c of CLASS_ORDER) if (found.indexOf(c) >= 0) return c;
    return 'SIGNAL';
  };
  const CLASS_WORD = { RAW: 'the raw supply input to the on-board regulator, not a regulated rail',
                       REF: 'a voltage-reference pin, not a supply' };
  const mergeRoles = (a, b) => a === b ? a
    : (a === 'POWER' && (b === '3V3' || b === '5V')) ? b
    : (b === 'POWER' && (a === '3V3' || a === '5V')) ? a : null;
  // physical header position of a component pin: explicit `pinNumbers` map wins,
  // else parsed from the leading "P<n>"/"<n>" of the pin name ("P17 3V3" → 17).
  function physOf(comp, pinName) {
    if (comp.pinNumbers && comp.pinNumbers[pinName] != null) return Number(comp.pinNumbers[pinName]);
    const m = /^P?(\d+)(?![\w])/i.exec(String(pinName).trim());
    return m ? parseInt(m[1], 10) : null;
  }
  // "…3V3 lives on physical pins 1, 17" — so the error tells you where to move the wire
  function suggestPins(po, role) {
    const want = ROLE_OK[role] || [];
    if (!want.some(c => c === '3V3' || c === '5V' || c === 'GND')) return '';
    const hits = Object.keys(po.pins).filter(n => want.indexOf(fnClass(po.pins[n])) >= 0);
    const kind = po.addressing === 'label' ? 'pin' : 'physical pin';
    return hits.length ? ` On this header, ${role} lives on ${kind}${hits.length > 1 ? 's' : ''} ${hits.join(', ')}.` : '';
  }

  // validateSpec(spec) → { errors: [html…], warnings: [html…] }. Pure — no DOM.
  // Errors are fatal: renderWiringGuide refuses to draw when any exist.
  function validateSpec(spec) {
    const errors = [], warnings = [];
    spec = normalizeSpec(spec);
    const p2p = !!(spec && spec.mode === 'point-to-point');
    const isInt = v => typeof v === 'number' && Number.isInteger(v);
    const isPosInt = v => isInt(v) && v > 0;
    const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isCoord = v => Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]);
    const show = v => { try { return JSON.stringify(v); } catch (e) { return String(v); } };

    // -- shape: the top-level lists must be lists of objects. Anything else is
    // reported here and dropped so the checks below can trust their input.
    const listOf = key => {
      const v = spec && spec[key];
      if (v == null) return [];
      if (!Array.isArray(v)) { errors.push(`<code>${key}</code> must be an array`); return []; }
      return v.filter((x, i) => { if (isObj(x)) return true; errors.push(`<code>${key}[${i}]</code> must be an object`); return false; });
    };
    const comps = listOf('components'), nets = listOf('nets');

    // -- ids: docs require every component and net to carry a UNIQUE id. A
    // duplicate silently merges two parts (one wins the lookup) or makes one
    // table row highlight several drawn objects; a missing one breaks the
    // row↔drawing link entirely. Neither may reach the renderer. Ids must also
    // fit ID_RE (see there for why). Lookups are prototype-free so an id like
    // "constructor" is neither a phantom hit nor a false duplicate.
    const checkIds = (list, what) => {
      const seen = new Set();
      list.forEach((x, i) => {
        if (x.id == null) { errors.push(`<code>${what}s[${i}]</code>: missing <code>id</code> — every ${what} needs a unique id`); return; }
        if (typeof x.id !== 'string' || !ID_RE.test(x.id)) { errors.push(`<code>${what}s[${i}]</code>: id <code>${show(x.id)}</code> is not a valid id — ${ID_RULE}`); return; }
        if (seen.has(x.id)) errors.push(`duplicate ${what} id "<code>${x.id}</code>" — ${what} ids must be unique`);
        seen.add(x.id);
      });
    };
    checkIds(comps, 'component'); checkIds(nets, 'net');
    const byId = Object.create(null); comps.forEach(c => { if (typeof c.id === 'string') byId[c.id] = c; });

    // -- board geometry (board mode only): resolve the grid FIRST so every
    // coordinate below is checked against the board that will actually be
    // drawn. An unknown preset used to fall through to the 20×20 default and an
    // off-board hole rendered clipped outside the viewBox — both looked like
    // valid guides. They are errors now.
    let board = null;
    if (!p2p) {
      const b = spec && spec.board;
      if (b != null && !isObj(b)) errors.push('<code>board</code> must be an object — a <code>{ preset }</code> or an explicit <code>{ cols, rows }</code> grid');
      else {
        const bo = b || {};
        let bad = false;
        if (bo.preset != null && !knownPreset(bo.preset)) {
          bad = true;
          errors.push(`<code>board.preset</code> "<code>${bo.preset}</code>" is not a known preset — known presets: ${Object.keys(PRESETS).join(', ')}`);
        }
        ['cols', 'rows'].forEach(k => {
          if (bo[k] != null && !isPosInt(bo[k])) { bad = true; errors.push(`<code>board.${k}</code> must be a positive whole number (got <code>${show(bo[k])}</code>)`); }
        });
        // electrocookie `boards`: a positive integer (n×1) or an { x, y } object.
        // The object form must carry at least one of x/y (a missing axis is 1)
        // and NOTHING else — an unknown key is almost certainly a typo'd axis
        // ({ xx: 2 }, { x: 2, yy: 3 }) and must fail loudly, never default.
        if (bo.preset === 'electrocookie-strip' && bo.boards != null) {
          const bs = bo.boards, rule = `<code>board.boards</code> must be a positive whole number or <code>{ x, y }</code> (at least one axis, each a positive whole number, no other keys)`;
          if (isObj(bs)) {
            const keys = Object.keys(bs), unknown = keys.filter(k => k !== 'x' && k !== 'y');
            const axes = keys.filter(k => k === 'x' || k === 'y');
            if (unknown.length) { bad = true; errors.push(`${rule} — unknown key${unknown.length > 1 ? 's' : ''} <code>${unknown.join(', ')}</code> in <code>${show(bs)}</code>`); }
            else if (!axes.length) { bad = true; errors.push(`${rule} — <code>${show(bs)}</code> names no axis`); }
            else if (!axes.every(k => isPosInt(bs[k]))) { bad = true; errors.push(`${rule} (got <code>${show(bs)}</code>)`); }
          } else if (!isPosInt(bs)) { bad = true; errors.push(`${rule} (got <code>${show(bs)}</code>)`); }
        }
        if (!bad) {
          const g = resolveBoard(bo);
          if (!isPosInt(g.cols) || !isPosInt(g.rows) || g.cols > MAX_BOARD_DIM || g.rows > MAX_BOARD_DIM)
            errors.push(`board resolves to ${g.cols}×${g.rows} holes — each dimension must be a whole number from 1 to ${MAX_BOARD_DIM} (check <code>cols</code>/<code>rows</code>/<code>boards</code>)`);
          else if (g.cols * g.rows > MAX_BOARD_HOLES)
            errors.push(`board resolves to ${g.cols}×${g.rows} = ${g.cols * g.rows} holes — more than the ${MAX_BOARD_HOLES}-hole limit a page can draw (check <code>cols</code>/<code>rows</code>/<code>boards</code>)`);
          else board = g;
        }
        // explicit bus runs override the preset's own, so they get the same range check
        if (board) ['rails', 'segments'].forEach(key => {
          const runs = bo[key];
          if (runs == null) return;
          if (!Array.isArray(runs)) { errors.push(`<code>board.${key}</code> must be an array of runs`); return; }
          runs.forEach((run, i) => {
            const where = `<code>board.${key}[${i}]</code>`;
            if (!isObj(run)) { errors.push(`${where} must be a run object`); return; }
            const horiz = run.row != null, vert = run.col != null;
            if (horiz === vert) { errors.push(`${where}: a run is either <code>{ row, c0, c1 }</code> or <code>{ col, r0, r1 }</code>`); return; }
            const [fixed, a, z, fixedMax, alongMax] = horiz
              ? [run.row, run.c0, run.c1, board.rows, board.cols]
              : [run.col, run.r0, run.r1, board.cols, board.rows];
            if (![fixed, a, z].every(isInt) || fixed < 1 || fixed > fixedMax || Math.min(a, z) < 1 || Math.max(a, z) > alongMax)
              errors.push(`${where} <code>${show(run)}</code> runs off the board (${board.cols} cols × ${board.rows} rows)`);
          });
        });
      }
    }
    const inRange = (c, r) => !board || (c >= 1 && c <= board.cols && r >= 1 && r <= board.rows);
    const extent = board ? ` — the board is ${board.cols} cols × ${board.rows} rows` : '';

    // -- labels: keys must name a real hole on this board --
    if (!p2p && spec && spec.labels != null) {
      if (!isObj(spec.labels)) errors.push('<code>labels</code> must be an object mapping "col,row" → text');
      else Object.keys(spec.labels).forEach(k => {
        const m = /^(\d+),(\d+)$/.exec(k);
        if (!m) errors.push(`label key "<code>${k}</code>" is not a "col,row" hole coordinate`);
        else if (!inRange(+m[1], +m[2])) errors.push(`label "<code>${spec.labels[k]}</code>" at hole (${k}) is off the board${extent}`);
      });
    }

    // module references: an unknown id draws nothing useful, and `module` +
    // `pinout` on one part is a contradiction (a breakout is not a header).
    comps.forEach(c => {
      if (!c || c.module == null) return;
      if (!resolveModule(c.module))
        errors.push(`component <code>${c.id}</code>: unknown module "<code>${c.module}</code>" — known modules: ${Object.keys(MODULES).join(', ')}`);
      if (c.pinout != null)
        errors.push(`component <code>${c.id}</code>: has both <code>module</code> and <code>pinout</code> — a part is either a board header (<code>pinout</code>) or a breakout (<code>module</code>), not both`);
    });

    // meta.notes: each entry is a string OR { html: string, type?: ok|warn|note }.
    // A bare string or {html} renders fine; anything else would render EMPTY, so
    // warn (don't block the whole guide over a note) — this closes the silent
    // empty-note-bar trap.
    const metaNotes = spec && spec.meta && spec.meta.notes;
    if (metaNotes != null) {
      if (!Array.isArray(metaNotes)) {
        warnings.push('<code>meta.notes</code> must be an array of strings or <code>{ html, type? }</code> objects');
      } else metaNotes.forEach((n, i) => {
        if (typeof n === 'string') return;
        if (!n || typeof n !== 'object' || typeof n.html !== 'string')
          warnings.push(`<code>meta.notes[${i}]</code>: use a string or <code>{ html: "…", type?: "ok"|"warn"|"note" }</code> — this note would render empty`);
        else if (n.type != null && ['ok', 'warn', 'note'].indexOf(String(n.type)) < 0)
          warnings.push(`<code>meta.notes[${i}]</code>: unknown type "<code>${n.type}</code>" — use "ok", "warn", or "note" (default)`);
      });
    }
    const colorKeys = ['fill', 'border', 'pin', 'label'];
    const isPlainObject = v => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
      const proto = Object.getPrototypeOf(v);
      return proto === Object.prototype || proto === null;
    };
    // hole "c,r" → {comp,pin}: lets [col,row] net endpoints resolve to pins (board
    // mode always; point-to-point mode for specs flipped over from a board).
    const holePin = Object.create(null);
    comps.forEach(c => {
      if (c && Object.prototype.hasOwnProperty.call(c, 'colors')) {
        if (!isPlainObject(c.colors))
          errors.push(`component <code>${c.id}</code>: <code>colors</code> must be an object with optional keys fill, border, pin, label`);
        else {
          colorKeys.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(c.colors, key) && typeof c.colors[key] !== 'string')
              errors.push(`component <code>${c.id}</code>: <code>colors.${key}</code> must be a string`);
          });
          Object.keys(c.colors).forEach(key => {
            if (colorKeys.indexOf(key) < 0)
              warnings.push(`component <code>${c.id}</code>: unknown color key "<code>${key}</code>" (known: fill, border, pin, label)`);
          });
        }
      }
      // span: the renderer destructures [[c0,r0],[c1,r1]] and draws the outline
      // at those holes, so a malformed or off-board span is a crash or an
      // invisible outline. (Ignored in point-to-point mode, so unchecked there.)
      if (!p2p && c.span != null) {
        const s = c.span;
        if (!Array.isArray(s) || s.length !== 2 || !isCoord(s[0]) || !isCoord(s[1]))
          errors.push(`component <code>${c.id}</code>: <code>span</code> must be <code>[[col, row], [col, row]]</code> (got <code>${show(s)}</code>)`);
        else if (!(inRange(s[0][0], s[0][1]) && inRange(s[1][0], s[1][1])))
          errors.push(`component <code>${c.id}</code>: span <code>${show(s)}</code> extends off the board${extent}`);
      }
      if (c.pins == null) return;
      if (!Array.isArray(c.pins)) {
        errors.push(`component <code>${c.id}</code>: <code>pins</code> must be an array of { label, loc?, notes? } objects`);
        return;
      }
      c.pins.forEach((pin, index) => {
        if (!pin || Array.isArray(pin) || typeof pin !== 'object' || typeof pin.label !== 'string') {
          errors.push(`component <code>${c.id}</code> pin ${index + 1}: need an object with string <code>label</code>`);
          return;
        }
        if (pin.notes != null && typeof pin.notes !== 'string')
          errors.push(`component <code>${c.id}</code> pin "<code>${pin.label}</code>": <code>notes</code> must be a string`);
        if (p2p) {
          // loc is optional here, but when present it is the reverse-lookup key
          // for [col,row] net endpoints, so it must still be a real coordinate
          // (the renderer indexes it with .join — a string would throw).
          if (pin.loc == null) return;
          if (!isCoord(pin.loc)) errors.push(`component <code>${c.id}</code> pin "<code>${pin.label}</code>": <code>loc</code>, when given, must be a [col, row] coordinate of whole numbers (got <code>${show(pin.loc)}</code>)`);
          else holePin[pin.loc.join(',')] = { comp: c.id, pin: pin.label };
          return;
        }
        if (!isCoord(pin.loc))
          errors.push(`component <code>${c.id}</code> pin "<code>${pin.label}</code>": <code>loc</code> must be a [col, row] coordinate of whole numbers in board mode (got <code>${show(pin.loc)}</code>)`);
        else if (!inRange(pin.loc[0], pin.loc[1]))
          errors.push(`component <code>${c.id}</code> pin "<code>${pin.label}</code>" at [${pin.loc}] is off the board${extent}`);
        else {
          holePin[pin.loc.join(',')] = { comp: c.id, pin: pin.label };
          // A board component's pins belong in its footprint. Span corners may
          // be supplied in either order, so compare against normalized bounds.
          if (Array.isArray(c.span) && c.span.length === 2 &&
              Array.isArray(c.span[0]) && c.span[0].length === 2 &&
              Array.isArray(c.span[1]) && c.span[1].length === 2) {
            const [[c0, r0], [c1, r1]] = c.span;
            const [col, row] = pin.loc;
            const minCol = Math.min(c0, c1), maxCol = Math.max(c0, c1);
            const minRow = Math.min(r0, r1), maxRow = Math.max(r0, r1);
            if (col < minCol || col > maxCol || row < minRow || row > maxRow)
              warnings.push(`component <code>${c.id}</code> pin "<code>${pin.label}</code>" at [${col},${row}] is outside its span [[${c0},${r0}],[${c1},${r1}]]`);
          }
        }
      });
    });

    // -- component level: bind pins to positions, audit the names --
    // Two addressing modes. NUMBERED headers (Pi/Pico): po.pins keyed by physical
    // pin number, resolved via physOf. LABEL boards (po.addressing==='label',
    // Arduino/ESP): po.pins keyed by silkscreen label; a pin resolves by matching
    // its name to a key or any of the key's "/"-separated aliases (so "D2",
    // "GPIO4" and "D2/GPIO4" all reach one pin). Downstream role/RESERVED checks
    // are identical either way — only the position lookup + wording differ.
    const nrm = x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const phys = {}; // "comp.pin" → { n, fn, cls, po, posDesc, posDescB }
    comps.forEach(c => {
      if (!c.pinout) return;
      // spec-level `pinouts` let a spec define its OWN board (any board opts into
      // validation without waiting on a built-in); they win over built-ins by name.
      const specPo = spec && spec.pinouts && spec.pinouts[c.pinout];
      const po = specPo ? Object.assign({ label: c.pinout + ' header' }, specPo) : PINOUTS[c.pinout];
      if (!po) { const known = Object.keys(PINOUTS).concat(Object.keys((spec && spec.pinouts) || {})); errors.push(`component <code>${c.id}</code>: unknown pinout "<code>${c.pinout}</code>" — known pinouts: ${known.join(', ')}`); return; }
      if (!po.pins || typeof po.pins !== 'object') { errors.push(`component <code>${c.id}</code>: pinout "<code>${c.pinout}</code>" has no <code>pins</code> map (need <code>{ label, pins: { "&lt;physical#&gt;": "&lt;function&gt;" } }</code>)`); return; }
      const byLabel = po.addressing === 'label';
      // label mode: normalized alias → canonical key (each "/"-part is an alias)
      let labelIndex = null;
      if (byLabel) {
        labelIndex = {};
        Object.keys(po.pins).forEach(k => {
          labelIndex[nrm(k)] = k;
          String(k).split('/').forEach(a => { if (nrm(a)) labelIndex[nrm(a)] = k; });
        });
      }
      const seen = {};
      pinsOf(c).forEach(name => {
        let key, fn, posDesc, posDescB;
        if (byLabel) {
          key = labelIndex[nrm(name)];
          if (key == null) { errors.push(`component <code>${c.id}</code> pin "<code>${name}</code>": no pin labeled "<code>${name}</code>" on the ${po.label} — valid labels: ${Object.keys(po.pins).join(', ')}`); return; }
          fn = po.pins[key];
          posDesc = `pin ${key}`; posDescB = `pin <b>${key}</b>`;
        } else {
          const n = physOf(c, name);
          if (n == null) { errors.push(`component <code>${c.id}</code> pin "<code>${name}</code>": cannot determine its physical position on the ${po.label} — name it "P&lt;number&gt; …" or map it in <code>pinNumbers</code>`); return; }
          fn = po.pins[n];
          if (!fn) { errors.push(`component <code>${c.id}</code> pin "<code>${name}</code>": physical pin ${n} does not exist on the ${po.label}`); return; }
          key = n; posDesc = `physical pin ${n}`; posDescB = `physical pin <b>${n}</b>`;
        }
        if (seen[key]) errors.push(`component <code>${c.id}</code>: pins "<code>${seen[key]}</code>" and "<code>${name}</code>" both claim ${posDesc}`);
        seen[key] = name;
        const cls = fnClass(fn);
        phys[c.id + '.' + name] = { n: key, fn, cls, po, posDesc, posDescB };
        // the pin's NAME may not lie about its function — UNLESS the name simply
        // IS the real function (e.g. "3V3_EN", "VSYS", "5V"), which is truthful
        // even when a token inside it (3V3, GND…) would otherwise infer a role. In
        // label mode the name IS the silkscreen label, so compare it whole (no
        // leading "P<n>" to strip).
        const bare = byLabel ? String(name) : String(name).replace(/^P?\d+\s*/i, '');
        const truthful = nrm(bare) && nrm(bare) === nrm(fn);
        const nameRole = roleFromName(bare);
        if (!truthful && nameRole && ROLE_OK[nameRole].indexOf(cls) < 0)
          errors.push(`component <code>${c.id}</code> pin "<code>${name}</code>": the name says <b>${nameRole}</b>, but ${posDescB} on the ${po.label} is <b>${fn}</b> (${cls}).${suggestPins(po, nameRole)}`);
        if (!truthful && !nameRole && (cls === '3V3' || cls === '5V' || cls === 'GND' || cls === 'RAW' || cls === 'REF'))
          errors.push(`component <code>${c.id}</code> pin "<code>${name}</code>": ${posDesc} is <b>${fn}</b> — a power/ground/reference pin must be named for what it is${byLabel ? '' : ` (e.g. "P${key} ${fn}")`} so the guide can never disguise it as a signal`);
        if (!byLabel) {
          const gm = /GPIO(\d+)/i.exec(name);
          if (gm && String(fn).toUpperCase().indexOf('GPIO' + gm[1]) < 0)
            errors.push(`component <code>${c.id}</code> pin "<code>${name}</code>": the name says GPIO${gm[1]}, but physical pin ${key} on the ${po.label} is <b>${fn}</b>`);
        }
      });
    });

    // -- net endpoints: every end must resolve. Board mode: a [col, row] hole ON
    // this board, or a "component.pin" / {comp, pin} reference to a pin that
    // exists. Point-to-point mode: a reference to an existing pin, or a
    // [col, row] that is some component pin's loc. Either way an unresolved end
    // is FATAL: the board renderer used to crash (TypeError on .join) and the
    // p2p renderer used to warn and silently drop the connection — a guide
    // that omits requested wiring is not a guide.
    nets.forEach(w => {
      ['from', 'to'].forEach(key => {
        const v = w[key], where = `net <code>${w.id}</code>.${key}`;
        if (Array.isArray(v)) {
          if (!isCoord(v)) errors.push(`${where} = <code>${show(v)}</code>: a hole is a [col, row] pair of whole numbers`);
          else if (p2p && !holePin[v.join(',')]) errors.push(`${where} = [${v}] is not the <code>loc</code> of any component pin (point-to-point mode has no board holes — use "component.pin")`);
          else if (!inRange(v[0], v[1])) errors.push(`${where} = [${v}] is off the board${extent}`);
          return;
        }
        let ref = null;
        if (typeof v === 'string') { const i = v.indexOf('.'); if (i > 0) ref = { comp: v.slice(0, i), pin: v.slice(i + 1) }; }
        else if (isObj(v) && v.comp != null) ref = { comp: String(v.comp), pin: v.pin };
        if (!ref) { errors.push(`${where} = <code>${show(v)}</code> is neither a [col, row] hole nor a "component.pin" reference`); return; }
        const c = byId[ref.comp];
        if (!c) { errors.push(`${where} = <code>${show(v)}</code>: no component "<code>${ref.comp}</code>" — components: ${comps.map(x => x.id).join(', ') || '(none)'}`); return; }
        if (!pinEntryOf(c, ref.pin)) errors.push(`${where} = <code>${show(v)}</code>: component "<code>${ref.comp}</code>" has no pin "<code>${ref.pin}</code>" — its pins: ${pinsOf(c).join(', ') || '(none)'}`);
        // the pin's own loc is validated on the component above
      });
    });

    // -- labels may SHORTEN a pin's drawn text but never contradict the pin --
    const labels = (spec && isObj(spec.labels)) ? spec.labels : {};
    for (const k in labels) {
      const hp = holePin[k]; if (!hp) continue;
      const lbl = String(labels[k]);
      const pm = phys[hp.comp + '.' + hp.pin];
      if (!pm) continue;
      if (typeof pm.n === 'number' && /^\d+$/.test(lbl) && parseInt(lbl, 10) !== pm.n)
        errors.push(`label override "<code>${lbl}</code>" at hole (${k}): that hole is <code>${hp.comp}</code> pin "<code>${hp.pin}</code>" = physical pin <b>${pm.n}</b> — the canvas would show "${lbl}" while the table says ${pm.n}`);
      const lblRole = roleFromName(lbl);
      if (lblRole && ROLE_OK[lblRole].indexOf(pm.cls) < 0)
        errors.push(`label override "<code>${lbl}</code>" at hole (${k}): claims <b>${lblRole}</b>, but <code>${hp.comp}.${hp.pin}</code> is ${pm.posDesc} = <b>${pm.fn}</b> (${pm.cls})`);
    }

    // -- net level: the wire's electrical role vs the physical pin it lands on --
    const resolveEnd = v => {
      if (typeof v === 'string') { const i = v.indexOf('.'); return i > 0 ? { comp: v.slice(0, i), pin: v.slice(i + 1) } : null; }
      if (Array.isArray(v)) return holePin[v.join(',')] || null;
      if (v && v.comp) return { comp: v.comp, pin: v.pin };
      return null;
    };
    nets.forEach(w => {
      const ends = [];
      ['from', 'to'].forEach(key => {
        const ref = resolveEnd(w[key]);
        if (ref && byId[ref.comp] && pinsOf(byId[ref.comp]).indexOf(ref.pin) >= 0) ends.push(ref);
      });
      // reserved pins (HAT ID EEPROM) must never be wired to, independent of
      // whether any electrical role resolves — otherwise a bare/roleless wire
      // slips straight onto pin 27/28 unflagged.
      ends.forEach(e => {
        const pm = phys[e.comp + '.' + e.pin];
        if (pm && pm.cls === 'RESERVED') {
          const why = /^ID_/i.test(pm.fn) ? 'reserved for the HAT ID EEPROM' : 'reserved / not usable for I/O';
          errors.push(`net <code>${w.id}</code>: <code>${e.comp}.${e.pin}</code> is ${pm.posDesc} = <b>${pm.fn}</b> (${why}) — do not wire to it`);
        }
      });
      // resolve the net's declared role: explicit `role`, else per-endpoint
      // `pinRoles` / pin-name inference; the two ends must agree.
      let role = null, src = null;
      if (w.role != null) {
        let r = String(w.role).toUpperCase(); if (r === 'VCC') r = 'POWER';
        if (!ROLE_OK[r]) errors.push(`net <code>${w.id}</code>: unknown role "<code>${w.role}</code>" — use 3V3, 5V, POWER, GND or SIGNAL`);
        else { role = r; src = '<code>role</code> on the net'; }
      }
      ends.forEach(e => {
        const c = byId[e.comp];
        let r = c.pinRoles && c.pinRoles[e.pin] != null ? String(c.pinRoles[e.pin]).toUpperCase() : roleFromName(e.pin);
        if (r === 'VCC') r = 'POWER';
        if (!r) return;
        if (!ROLE_OK[r]) { errors.push(`component <code>${c.id}</code> pinRoles["<code>${e.pin}</code>"]: unknown role "<code>${r}</code>" — use 3V3, 5V, POWER, GND or SIGNAL`); return; }
        if (!role) { role = r; src = `<code>${e.comp}.${e.pin}</code>`; return; }
        const m = mergeRoles(role, r);
        if (!m) errors.push(`net <code>${w.id}</code> ("${w.label || ''}"): the two ends disagree about what this wire is — ${src} says <b>${role}</b> but <code>${e.comp}.${e.pin}</code> says <b>${r}</b>`);
        else role = m;
      });
      if (!role) return;
      // the hard check: a power/ground/signal wire must land on a pin of that
      // role. RAW (regulator input) and REF (reference) pins are in no role's
      // list, so any role-bearing net is refused there with a plain-words why.
      ends.forEach(e => {
        const pm = phys[e.comp + '.' + e.pin];
        if (!pm || pm.cls === 'RESERVED') return; // RESERVED already flagged above, role-independent
        if (ROLE_OK[role].indexOf(pm.cls) < 0)
          errors.push(`net <code>${w.id}</code> ("${w.label || ''}"): this is a <b>${role}</b> connection, but <code>${e.comp}.${e.pin}</code> is ${pm.posDescB} on the ${pm.po.label} = <b>${pm.fn}</b> (${CLASS_WORD[pm.cls] || pm.cls}), not ${role}.${suggestPins(pm.po, role)}`);
      });
    });
    return { errors, warnings };
  }

  const stripHtml = h => String(h).replace(/<[^>]+>/g, '');
  class WiringValidationError extends Error {
    constructor(errors) {
      super('wiring-guide validation failed (' + errors.length + ' error(s)):\n - ' + errors.map(stripHtml).join('\n - '));
      this.name = 'WiringValidationError';
      this.errors = errors.map(stripHtml);
    }
  }

  // Resolve + apply the theme classes on the mount. Called by both render
  // entry points BEFORE the validation gate, so an error box is themed like a
  // successful render would be, and a stale .wg-light from an earlier render
  // is cleared when the new call asks for dark.
  function applyTheme(mount, o) {
    injectCSS();
    mount.classList.add('wg');
    mount.classList.toggle('wg-light', o.theme === 'light');
  }

  // hard gate: mount a visible error box AND throw. A failing spec must never
  // silently draw — the box is for humans, the throw is for programs.
  function failValidation(spec, mount, errors) {
    injectCSS();
    mount.classList.add('wg');
    mount.innerHTML = '';
    const meta = (spec && spec.meta) || {};
    if (meta.title) mount.appendChild(el('h1', null, meta.title));
    mount.appendChild(el('div', { class: 'warn' },
      `<strong>✋ VALIDATION FAILED — ${errors.length} error(s). Nothing was drawn.</strong><br>` +
      `The spec cannot render a lie. Fix these, then re-render:` +
      `<ul style="margin:8px 0 0;padding-left:20px">` + errors.map(e => `<li>${e}</li>`).join('') + `</ul>`));
    if (typeof console !== 'undefined') console.error('wiring-guide: validation failed:', errors.map(stripHtml));
    throw new WiringValidationError(errors);
  }

  // Warnings do not prevent rendering, but must remain visible in a generated
  // guide so a misplaced footprint pin is not silently overlooked.
  function showValidationWarnings(mount, warnings) {
    if (!warnings.length) return;
    mount.appendChild(el('div', { class: 'warn' },
      `<strong>⚠ ${warnings.length} validation warning(s)</strong><br>` +
      `<ul style="margin:8px 0 0;padding-left:20px">` + warnings.map(w => `<li>${w}</li>`).join('') + `</ul>`));
    if (typeof console !== 'undefined') console.warn('wiring-guide: validation warnings:', warnings.map(stripHtml));
  }

  // ---- shared meta blocks (used by both modes) ----
  function headerMeta(mount, meta) {
    if (meta.title) mount.appendChild(el('h1', null, meta.title));
    if (meta.intro) mount.appendChild(el('p', { class: 'sub' }, meta.intro));
    // A note may be a plain string (→ neutral) or { html, type? } where type is
    // 'ok' (green), 'warn' (red) or 'note'/omitted (neutral). Strings are the
    // forgiving common case — they never render empty, and validateSpec warns on
    // a malformed object so the old silent-empty-bar trap can't recur.
    // `notes` that is not an array is a validator WARNING (never fatal — a note
    // must not block the whole guide), so the renderer must survive it: treat it
    // as no notes rather than .forEach-ing a string. The warning box says why.
    (Array.isArray(meta.notes) ? meta.notes : []).forEach(n => {
      const note = typeof n === 'string' ? { html: n } : (n && typeof n === 'object' ? n : { html: String(n) });
      const cls = note.type === 'ok' ? 'ok' : note.type === 'warn' ? 'warn' : 'note';
      mount.appendChild(el('div', { class: cls }, note.html != null ? note.html : ''));
    });
  }
  function footerMeta(mount, meta, o, svg, spec) {
    o = o || OPT_DEFAULTS;
    const netById = {};
    (spec.nets || []).forEach(w => { if (w.id) netById[w.id] = w; });
    const ids = Object.keys(netById).sort((a, b) => b.length - a.length);
    const addStep = html => {
      const step = el('div', { class: 'step' }, html);
      decorateRefs(step, svg, netById, ids, o.theme);
      return step;
    };
    if (o.buildOrder && meta.buildOrder && meta.buildOrder.length) {
      const d = el('details', { open: '' }); d.appendChild(el('summary', null, 'Build order'));
      meta.buildOrder.forEach((s, i) => d.appendChild(addStep(`${i + 1}. ${s}`)));
      mount.appendChild(d);
    }
    if (o.checks && meta.checks && meta.checks.length) {
      const d = el('details'); d.appendChild(el('summary', null, 'Pre-power checks'));
      meta.checks.forEach(s => d.appendChild(addStep(s)));
      mount.appendChild(d);
    }
  }
  // ---- reference ↔ svg hover/click highlight linking (shared visual convention)
  // Both entry points drive the same hover=preview / click=pin model, but the
  // ARIA lives ONLY on real <button>s: `aria-pressed` and focusability are not
  // allowed on a bare <tr>/<span> (axe aria-allowed-attr, critical), and
  // turning a table row into a button would strip its table semantics.
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const highlightSet = (svg, id, on) => svg.querySelectorAll(`[data-id="${id}"]`).forEach(e => e.classList.toggle('hl', on));

  // Pin state is held PER NET, per rendered SVG — not per control. A net can
  // have several controls (its wires-table row AND every build-step mention),
  // and they must always agree: one pinned flag drives the `pinned` class and
  // aria-pressed on all of them plus the SVG highlight, and a hover-leave on
  // any control only clears the highlight when the NET is unpinned (so an
  // unpinned build-step button can no longer wipe a highlight the row owns).
  const PIN_STATE = new WeakMap(); // svg → { [netId]: { pinned, controls: [{ el, btn }] } }
  function netState(svg, id) {
    let map = PIN_STATE.get(svg);
    if (!map) { map = Object.create(null); PIN_STATE.set(svg, map); }
    return map[id] || (map[id] = { pinned: false, controls: [] });
  }
  function setPinned(svg, id, on) {
    const st = netState(svg, id);
    st.pinned = on;
    st.controls.forEach(c => {
      c.el.classList.toggle('pinned', on);
      const b = c.btn(); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    highlightSet(svg, id, on);
  }
  // Wire one control (el = element that gets `pinned` + the listeners; btn()
  // = the real <button> that exposes aria-pressed) into the net's shared state.
  function registerControl(svg, id, el, btn, evts) {
    const st = netState(svg, id);
    st.controls.push({ el, btn });
    const show = () => highlightSet(svg, id, true);
    const hide = () => { if (!st.pinned) highlightSet(svg, id, false); };
    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener(evts.focus, show);
    el.addEventListener(evts.blur, hide);
    el.addEventListener('click', () => setPinned(svg, id, !st.pinned));
  }

  // linkRef(btn, svg, id): `btn` is a real <button> (native keyboard
  // activation, so no keydown shim). Focus mirrors hover; click toggles the
  // net's pin, exposed through aria-pressed on every control of that net.
  function linkRef(btn, svg, id) {
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-pressed', 'false');
    registerControl(svg, id, btn, () => btn, { focus: 'focus', blur: 'blur' });
  }
  // The swatch cell of a wires-table row, carrying the row's toggle button.
  // Emitted as HTML so the row sites can keep building rows via innerHTML.
  const swatchCell = (label, color) =>
    `<td class="sw"><button type="button" class="rowbtn" aria-pressed="false" aria-label="Highlight ${escAttr(stripHtml(label))} on the diagram">` +
    `<span class="swatch" style="background:${color}"></span></button></td>`;
  // linkRow(tr, svg, id): the whole row stays mouse-hoverable/clickable (a
  // pointer convenience), while keyboard + assistive tech go through the
  // .rowbtn inside the swatch cell. Handlers are delegated on the <tr> so
  // the button's own click/focus bubble up and there is exactly one toggle.
  function linkRow(tr, svg, id) {
    tr.setAttribute('data-net', id);
    registerControl(svg, id, tr, () => tr.querySelector('button.rowbtn'), { focus: 'focusin', blur: 'focusout' });
  }
  // SVG screen-reader labeling: role="img" + <title>/<desc>. The <desc> points
  // at the wires/pins tables, which are the canonical TEXT EQUIVALENT of the
  // diagram — the primary accessibility path for the whole tool.
  function a11ySvg(svg, spec) {
    svg.setAttribute('role', 'img');
    const meta = (spec && spec.meta) || {};
    const t = mk('title'); t.textContent = meta.title || 'Wiring diagram';
    const d = mk('desc');
    const intro = meta.intro ? String(meta.intro).replace(/<[^>]+>/g, '').trim() + ' ' : '';
    d.textContent = intro + 'A full text equivalent follows in the wires and pin tables below.';
    svg.appendChild(t); svg.appendChild(d);
  }
  // A hover/screen-reader <title> on a drawn wire — identifies it WITHOUT relying
  // on color (the redundant channel colorblind users need).
  function wireTitle(elm, w) {
    const t = mk('title');
    const base = w.label || w.id || 'wire';
    const role = ROLE_NAME[netKey(w)];
    // Name the role in the title so it survives with BOTH color and dash stripped.
    t.textContent = role ? `${base} — ${role}` : base;
    elm.appendChild(t);
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // Wrap every net-id mention in a build step in a real <button class="wref">
  // linked to the drawing. Text color comes from the TEXT palette (AA on the
  // theme's panel), never the drawing palette — see textCol().
  function decorateRefs(stepEl, svg, netById, ids, theme) {
    if (!ids.length) return;
    const re = new RegExp('\\b(' + ids.map(escapeRegExp).join('|') + ')\\b', 'g');
    const walker = document.createTreeWalker(stepEl, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(textNode => {
      const text = textNode.nodeValue;
      re.lastIndex = 0;
      let match, last = 0;
      const frag = document.createDocumentFragment();
      while ((match = re.exec(text))) {
        if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        const btn = document.createElement('button');
        btn.className = 'wref'; btn.setAttribute('data-ref', match[1]); btn.textContent = match[1];
        btn.style.color = textCol(netById[match[1]].color, theme);
        linkRef(btn, svg, match[1]);
        frag.appendChild(btn); last = re.lastIndex;
      }
      if (last) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
      }
    });
  }

  // Fail loudly and clearly on a missing/invalid mount or spec rather than
  // throwing an opaque "cannot read properties of null" deep in the renderer.
  function assertRenderArgs(spec, mount) {
    if (!spec || typeof spec !== 'object')
      throw new TypeError('wiring-guide: renderWiringGuide(spec, mount) needs a spec object');
    if (!mount || typeof mount.appendChild !== 'function' || !mount.classList)
      throw new TypeError('wiring-guide: renderWiringGuide(spec, mount) needs a DOM element to mount into');
  }

  function renderWiringGuide(spec, mount, opts) {
    assertRenderArgs(spec, mount);
    spec = normalizeSpec(spec);
    const v = validateSpec(spec);
    const o = resolveOpts(spec, opts);
    // Theme is applied BEFORE the validation gate so the error box honors the
    // requested theme too (and a mount that rendered light earlier does not
    // keep .wg-light when a later, failing render asks for dark).
    applyTheme(mount, o);
    if (v.errors.length) failValidation(spec, mount, v.errors); // throws
    if (spec && spec.mode === 'point-to-point') return renderPointToPoint(spec, mount, v, opts);
    mount.innerHTML = '';
    const board = resolveBoard(spec.board || {});
    const meta = spec.meta || {};

    // light DRC — same-hole collisions only (NOT full net-tracing). A hole is a hazard
    // if ≥2 physical things want it: 2+ net legs, or a leg on a non-socket part pin.
    // A single jumper landing on a `socket:true` component pin (e.g. an ESP header) is fine.
    const occ = Object.create(null);
    const compById = Object.create(null); (spec.components || []).forEach(c => { compById[c.id] = c; });
    const pointOf = endpoint => {
      if (Array.isArray(endpoint)) return endpoint;
      const ref = typeof endpoint === 'string' ? (() => { const i = endpoint.indexOf('.'); return i > 0 ? { comp: endpoint.slice(0, i), pin: endpoint.slice(i + 1) } : null; })()
        : endpoint && endpoint.comp ? endpoint : null;
      const pin = ref && compById[ref.comp] && pinEntryOf(compById[ref.comp], ref.pin);
      return pin && pin.loc;
    };
    // Render-time guard: validateSpec already rejects an endpoint that does not
    // resolve, so this is unreachable through the public entry points — but if
    // it ever is reached, fail with a message that names the net, not a
    // TypeError from deep inside the DRC.
    const holeOf = (w, key) => {
      const pt = pointOf(w[key]);
      if (!Array.isArray(pt)) throw new Error(`wiring-guide: net ${w.id} ${key} endpoint ${JSON.stringify(w[key])} does not resolve to a board hole`);
      return pt;
    };
    (spec.components || []).forEach(c => positionedPinsOf(c).forEach(p => {
      const k = p.loc.join(','); (occ[k] = occ[k] || []).push({ t: 'pin', socket: !!c.socket, ref: `${c.id}.${p.label}` });
    }));
    (spec.nets || []).forEach(w => { ['from', 'to'].forEach(e => { const k = holeOf(w, e).join(','); (occ[k] = occ[k] || []).push({ t: 'leg', ref: `${w.id}.${e}` }); }); });
    const hazards = [];
    for (const k in occ) {
      const o = occ[k], legs = o.filter(x => x.t === 'leg').length, hardPins = o.filter(x => x.t === 'pin' && !x.socket).length;
      if (legs + hardPins >= 2) hazards.push({ hole: k, refs: o.map(x => x.ref) });
    }
    const PITCH = 26, MX = 46, MY = 30, HR = 7.5;
    const cx = c => MX + (c - 1) * PITCH, cy = r => MY + (r - 1) * PITCH;
    const vbW = MX + board.cols * PITCH, vbH = MY + (board.rows + 1) * PITCH;

    // header
    headerMeta(mount, meta);
    showValidationWarnings(mount, v.warnings);
    if (o.drc && hazards.length) {
      if (typeof console !== 'undefined') console.warn('wiring-guide: ' + hazards.length + ' hole collision(s):', hazards);
      const rows = hazards.map(z => `(${z.hole}): ${z.refs.join(' + ')}`).join('<br>');
      mount.appendChild(el('div', { class: 'warn' }, `<strong>⚠ ${hazards.length} hole collision(s)</strong> — two leads want one hole. Move one into an adjacent hole of the same bus run:<br>${rows}`));
    }

    // board svg
    mount.appendChild(el('h2', null, 'Board map'));
    const wrap = el('div', { class: 'sticky-board' });
    const svg = mk('svg', { viewBox: `0 0 ${vbW} ${vbH}`, preserveAspectRatio: 'xMidYMid meet' });
    attachPanZoom(svg);
    a11ySvg(svg, spec);
    wrap.appendChild(svg);
    if (o.hints) wrap.appendChild(el('p', { class: 'hint' }, 'Hover (or tap) a wires-table row below — its endpoints + path highlight. Click to pin. Focus the diagram and use arrow keys to pan, + / − to zoom, 0 to reset.'));
    mount.appendChild(wrap);

    // buses — orientation-aware: horizontal {row,c0,c1} or vertical {col,r0,r1}.
    // Run ends may be given in either order; normalize so a reversed run never
    // becomes a negative-width rect (which SVG silently does not draw).
    const busRect = (o, pad, thick) => {
      if (o.row != null) {
        const a = Math.min(o.c0, o.c1), z = Math.max(o.c0, o.c1);
        return { x: cx(a) - pad, y: cy(o.row) - thick / 2, w: (z - a) * PITCH + pad * 2, h: thick };
      }
      const a = Math.min(o.r0, o.r1), z = Math.max(o.r0, o.r1);
      return { x: cx(o.col) - thick / 2, y: cy(a) - pad, w: thick, h: (z - a) * PITCH + pad * 2 };
    };
    board.segments.forEach(s => { const r = busRect(s, 11, 22); svg.appendChild(mk('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 6, class: 'seg' })); });
    board.rails.forEach(rl => {
      const r = busRect(rl, 9, 18); svg.appendChild(mk('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 5, class: 'rail' }));
      const vert = rl.col != null;
      const t = mk('text', { x: vert ? cx(rl.col) : cx(Math.min(rl.c0, rl.c1)) - 6, y: vert ? 14 : cy(rl.row), 'text-anchor': vert ? 'middle' : 'end', 'dominant-baseline': 'central', class: 'glabel', fill: '#5fb6cf' });
      t.textContent = rl.label || 'rail'; svg.appendChild(t);
    });
    // holes + guide labels
    for (let c = 1; c <= board.cols; c++) for (let r = 1; r <= board.rows; r++)
      svg.appendChild(mk('circle', { cx: cx(c), cy: cy(r), r: HR, class: 'hole' }));
    if (!board.noColAxis)
      for (let c = 1; c <= board.cols; c += 2) { const t = mk('text', { x: cx(c), y: cy(board.rows) + 18, 'text-anchor': 'middle', class: 'glabel' }); t.textContent = c; svg.appendChild(t); }
    if (!board.noRowAxis)
      for (let r = 1; r <= board.rows; r += 2) { const t = mk('text', { x: 16, y: cy(r), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'glabel' }); t.textContent = r; svg.appendChild(t); }
    // per-strip node numbers (e.g. Jumperless: each terminal strip's routing id)
    (board.nodeLabels || []).forEach(n => { const t = mk('text', { x: cx(n.col), y: cy(n.row), 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'glabel', fill: '#5fb6cf' }); t.textContent = n.text; svg.appendChild(t); });

    // components (outline + label + pin labels)
    // Single source of truth for what a hole IS: `holeInfo` maps hole → resolved
    // {text, comp, pin}. The SVG hole text, the per-component pin tables and the
    // wires table all read THIS map, so canvas and tables physically cannot
    // disagree. spec.labels may shorten a pin's DRAWN text (kept in .text, shown
    // alongside the pin name in the tables); validateSpec rejects overrides that
    // contradict a pinout-backed pin.
    const holeInfo = {};
    (spec.components || []).forEach(cp => {
      if (cp.span) {
        // corners may be supplied in either order (validateSpec accepts both);
        // normalize so the outline never has a negative width/height.
        const c0 = Math.min(cp.span[0][0], cp.span[1][0]), c1 = Math.max(cp.span[0][0], cp.span[1][0]);
        const r0 = Math.min(cp.span[0][1], cp.span[1][1]), r1 = Math.max(cp.span[0][1], cp.span[1][1]);
        const outline = mk('rect', { x: cx(c0) - 13, y: cy(r0) - 13, width: (c1 - c0) * PITCH + 26, height: (r1 - r0) * PITCH + 26, rx: 6, class: 'comp-outline' });
        if (cp.colors && cp.colors.fill) outline.style.fill = col(cp.colors.fill);
        if (cp.colors && cp.colors.border) outline.style.stroke = col(cp.colors.border);
        svg.appendChild(outline);
        if (cp.label) {
          const short = (r1 - r0) <= 1;
          const t = mk('text', { x: cx((c0 + c1) / 2), y: short ? cy(r0) - 20 : cy(Math.round((r0 + r1) / 2)), 'text-anchor': 'middle', class: 'glabel', fill: (cp.colors && cp.colors.label) ? col(cp.colors.label) : '#c084fc' });
          t.textContent = cp.label; svg.appendChild(t);
        }
      }
      positionedPinsOf(cp).forEach(p => {
        const [c, r] = p.loc;
        holeInfo[c + ',' + r] = { text: p.label, comp: cp.id, pin: p.label, notes: p.notes };
      });
    });
    for (const k in (spec.labels || {})) {
      if (holeInfo[k]) holeInfo[k].text = String(spec.labels[k]); // display override of the SAME entry — pin identity stays
      else holeInfo[k] = { text: String(spec.labels[k]) };        // annotation on a bare hole (rails etc.)
    }

    // nets (wires/resistors/diodes/caps)
    (spec.nets || []).forEach(w => {
      const from = holeOf(w, 'from'), to = holeOf(w, 'to');
      const [ax, ay] = [cx(from[0]), cy(from[1])], [bx, by] = [cx(to[0]), cy(to[1])];
      const key = netKey(w);
      const c = col(key);
      if (w.kind === 'resistor' || w.kind === 'cap') {
        const e = mk('path', { class: 'resistor', 'data-id': w.id, d: zig(ax, ay, bx, by) }); e.style.stroke = c; wireTitle(e, w); svg.appendChild(e);
      } else if (w.kind === 'diode') {
        const e = mk('path', { class: 'diode', 'data-id': w.id, d: `M${ax},${ay} L${bx},${by}` }); e.style.stroke = c; wireTitle(e, w); svg.appendChild(e);
        const horiz = Math.abs(by - ay) < Math.abs(bx - ax);
        const band = horiz
          ? mk('line', { x1: bx - (bx > ax ? 7 : -7), y1: by - 7, x2: bx - (bx > ax ? 7 : -7), y2: by + 7, stroke: c, 'stroke-width': 3, 'data-id': w.id })
          : mk('line', { x1: bx - 7, y1: by + (by > ay ? -7 : 7), x2: bx + 7, y2: by + (by > ay ? -7 : 7), stroke: c, 'stroke-width': 3, 'data-id': w.id });
        svg.appendChild(band);
      } else {
        // plain jumper: the dash pattern is the colorblind-safe role channel
        const attrs = { class: 'wire', 'data-id': w.id, d: `M${ax},${ay} L${bx},${by}` };
        const dash = dashOf(key); if (dash) attrs['stroke-dasharray'] = dash;
        const e = mk('path', attrs); e.style.stroke = c; wireTitle(e, w); svg.appendChild(e);
      }
    });

    // labeled holes on top — text comes from the same holeInfo entry the tables read
    for (const k in holeInfo) {
      const [c, r] = k.split(',').map(Number);
      const owner = compById[holeInfo[k].comp];
      const pinStroke = (owner && owner.colors && owner.colors.pin) ? col(owner.colors.pin) : 'rgba(255,255,255,.5)';
      svg.appendChild(mk('circle', { cx: cx(c), cy: cy(r), r: HR, fill: 'none', stroke: pinStroke, 'stroke-width': 2 }));
      const t = mk('text', { x: cx(c), y: cy(r), class: 'hlabel' }); t.textContent = holeInfo[k].text; svg.appendChild(t);
    }

    // legend + component pin tables
    const gridDiv = el('div', { class: 'grid' });
    const left = el('div'); const right = el('div');
    if (o.legend && spec.legend && spec.legend.length) {
      left.appendChild(el('h2', { style: 'margin-top:0' }, 'Legend'));
      spec.legend.forEach(lg => { left.appendChild(el('div', { class: 'legend-row' }, `${swatchLine(lg.color)}${lg.label}`)); });
    }
    (o.pinTables ? (spec.components || []) : []).filter(cp => pinEntries(cp).length && cp.pinTable !== false).forEach(cp => {
      right.appendChild(el('h2', { style: right.childNodes.length ? '' : 'margin-top:0' }, (cp.label || cp.id) + ' pins'));
      const hasNotes = positionedPinsOf(cp).some(p => p.notes);
      const tbl = el('table'); let h = `<tr><th>${cp.label || cp.id} pin</th><th>Hole</th>${hasNotes ? '<th>Notes</th>' : ''}</tr>`;
      positionedPinsOf(cp).forEach(p => {
        const info = holeInfo[p.loc.join(',')] || { text: p.label };
        const drawn = info.text !== p.label ? ` <span class="sub">drawn “${info.text}”</span>` : '';
        h += `<tr><td class="pin">${p.label}</td><td class="pin">(${p.loc})${drawn}</td>${hasNotes ? `<td>${p.notes || ''}</td>` : ''}</tr>`;
      });
      tbl.innerHTML = h; right.appendChild(scrollWrap(tbl));
    });
    gridDiv.appendChild(left); gridDiv.appendChild(right);
    mount.appendChild(gridDiv);

    // wires table — endpoint cells resolve through the SAME holeInfo map as the
    // canvas: a hole that is a component pin is shown as that pin, so the table
    // can never claim a different pin than the drawing.
    const endCell = pt => {
      const resolved = pointOf(pt);
      const info = holeInfo[(resolved || []).join(',')];
      return info && info.pin ? `${info.comp} <b>${info.pin}</b> <span class="sub">(${resolved})</span>` : `(${resolved})`;
    };
    mount.appendChild(el('h2', null, 'Wires & components'));
    const tbl = el('table');
    tbl.innerHTML = '<thead><tr><th>#</th><th>What</th><th>A</th><th>B</th><th>Part</th><th>Notes</th></tr></thead>';
    const tb = el('tbody');
    (spec.nets || []).forEach(w => {
      const c = col(w.color || (w.kind === 'resistor' || w.kind === 'cap' ? 'r' : w.kind === 'diode' ? 'd' : 'sig'));
      const tr = el('tr', { class: 'wrow' });
      tr.innerHTML = `${swatchCell(w.label || w.id, c)}
        <td>${w.label || w.id}</td><td class="pin">${endCell(w.from)}</td><td class="pin">${endCell(w.to)}</td>
        <td>${w.value || w.kind || ''}</td><td>${w.note || ''}</td>`;
      linkRow(tr, svg, w.id);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); mount.appendChild(scrollWrap(tbl));

    // meta sections
    footerMeta(mount, meta, o, svg, spec);
    return mount;
  }

  /* ---- point-to-point mode ---------------------------------------------------
   * spec.mode === "point-to-point": no board, no grid. Components are drawn as
   * pin-header cards; nets are direct pin→pin wires rendered as a hub-and-spoke
   * column layout + a numbered, phase-grouped connection table (the build order).
   *
   * Net endpoints accept three forms:
   *   "comp.pin"        — native p2p authoring (pin name after the FIRST dot)
   *   {comp, pin}       — explicit object form
   *   [col, row]        — board-mode hole coords, reverse-resolved through the
   *                       components' pin maps, so an existing perfboard spec can
   *                       flip to p2p by adding `"mode": "point-to-point"`.
   * Component pins are object entries. In p2p their `loc` values are ignored;
   * array order is the physical header and drawing order.
   */
  function renderPointToPoint(spec, mount, validation, opts) {
    // Direct callers get the same validation gate; renderWiringGuide passes its
    // already-computed result so warnings can be displayed without revalidating.
    assertRenderArgs(spec, mount);
    spec = normalizeSpec(spec);
    const v = validation && validation !== true ? validation : validateSpec(spec);
    const o = resolveOpts(spec, opts);
    applyTheme(mount, o); // before the gate — see renderWiringGuide
    if (v.errors.length) failValidation(spec, mount, v.errors); // throws
    mount.innerHTML = '';
    const meta = spec.meta || {};
    const comps = spec.components || [];

    const byId = Object.create(null); comps.forEach(c => { byId[c.id] = c; });
    const nameOf = c => c.short || c.id; // table-cell name; full c.label goes on the diagram

    // board-spec reuse: hole coord -> {comp, pin}. Only a real coordinate array
    // is indexed (validateSpec rejects anything else; never .join a string).
    const holePin = Object.create(null);
    comps.forEach(c => positionedPinsOf(c).forEach(p => { if (Array.isArray(p.loc) && p.loc.length === 2) holePin[p.loc.join(',')] = { comp: c.id, pin: p.label }; }));

    // Unresolved endpoints are a validateSpec ERROR now, so `problems` is a
    // defensive guard for the impossible case, kept visible rather than silent.
    const problems = [];
    const resolve = (w, key) => {
      const v = w[key]; let ref = null;
      if (typeof v === 'string') { const i = v.indexOf('.'); if (i > 0) ref = { comp: v.slice(0, i), pin: v.slice(i + 1) }; }
      else if (Array.isArray(v)) ref = holePin[v.join(',')];
      else if (v && v.comp) ref = { comp: v.comp, pin: v.pin };
      const index = ref && byId[ref.comp] ? pinsOf(byId[ref.comp]).indexOf(ref.pin) : -1;
      if (!ref || !byId[ref.comp] || index < 0) {
        problems.push(`<code>${w.id || '?'}</code>.${key} = <code>${JSON.stringify(v)}</code> is not a known component pin`);
        return null;
      }
      return Object.assign(ref, { index });
    };
    const conns = [];
    (spec.nets || []).forEach(w => { const a = resolve(w, 'from'), b = resolve(w, 'to'); if (a && b) conns.push({ w, a, b }); });

    // light DRC (p2p flavor): unresolved endpoints (above) + pin fan-out — >1 wire
    // on one physical pin is legal but means stacked solder joints; surface it.
    const fan = {};
    conns.forEach(c => [c.a, c.b].forEach(e => { const k = pinKey(e.comp, e.index); (fan[k] = fan[k] || []).push(c.w.id); }));
    const stacked = Object.keys(fan).filter(k => fan[k].length > 1);

    headerMeta(mount, meta);
    showValidationWarnings(mount, v.warnings);
    if (problems.length) {
      if (typeof console !== 'undefined') console.warn('wiring-guide p2p: unresolved endpoints:', problems);
      mount.appendChild(el('div', { class: 'warn' }, `<strong>⚠ ${problems.length} unresolved endpoint(s)</strong> — these nets were skipped:<br>${problems.join('<br>')}`));
    }
    if (o.drc && stacked.length) mount.appendChild(el('div', { class: 'warn' }, `<strong>⚠ Stacked joints</strong> — more than one wire lands on: ` + stacked.map(k => {
      const [comp, index] = k.split('.'); return `<code>${comp}.${pinEntries(byId[comp])[Number(index)].label}</code> (${fan[k].join(', ')})`;
    }).join(' · ') + `. Legal, but solder all leads on that pin in one pass.`));

    // ---- layout: hub-and-spoke columns (BFS depth from the busiest component) ----
    // NOTE: layout is a heuristic — hub = highest connection count (override
    // with `"hub": true` on a component). Good enough for module→Pi builds;
    // a hand-placed `pos` escape hatch may be wanted for weird topologies.
    const deg = {}; conns.forEach(c => { deg[c.a.comp] = (deg[c.a.comp] || 0) + 1; deg[c.b.comp] = (deg[c.b.comp] || 0) + 1; });
    const hub = comps.find(c => c.hub) || comps.reduce((m, c) => (m == null || (deg[c.id] || 0) > (deg[m.id] || 0) ? c : m), null);
    const adj = {}; conns.forEach(c => { (adj[c.a.comp] = adj[c.a.comp] || new Set()).add(c.b.comp); (adj[c.b.comp] = adj[c.b.comp] || new Set()).add(c.a.comp); });
    const depth = {};
    if (hub) { depth[hub.id] = 0; let fr = [hub.id]; while (fr.length) { const nx = []; fr.forEach(id => (adj[id] || new Set()).forEach(n => { if (!(n in depth)) { depth[n] = depth[id] + 1; nx.push(n); } })); fr = nx; } }
    let maxD = 0; comps.forEach(c => { if (c.id in depth) maxD = Math.max(maxD, depth[c.id]); });
    comps.forEach(c => { if (!(c.id in depth)) depth[c.id] = conns.length ? maxD + 1 : 0; }); // disconnected parts park in a far column

    const PPITCH = 24, HDR = 12, W = 200, GAPX = 200, GAPY = 44, M = 28;
    const boxH = c => HDR + Math.max(pinsOf(c).length, 1) * PPITCH + 10;
    const nCols = comps.length ? Math.max(...comps.map(c => depth[c.id])) + 1 : 1;
    const columns = []; for (let k = 0; k < nCols; k++) columns.push(comps.filter(c => depth[c.id] === k));

    // stack each column; order columns >0 by barycenter of already-placed peers
    const topY = {}; // component top y
    const pinIdx = {}; comps.forEach(c => pinEntries(c).forEach((p, i) => { pinIdx[pinKey(c.id, i)] = i; }));
    const pinY = e => topY[e.comp] + HDR + (pinIdx[pinKey(e.comp, e.index)] + 0.5) * PPITCH;
    columns.forEach((cc, k) => {
      if (k > 0) {
        const bary = {};
        cc.forEach(c => {
          const ys = [];
          conns.forEach(cn => {
            if (cn.a.comp === c.id && topY[cn.b.comp] != null && depth[cn.b.comp] < k) ys.push(pinY(cn.b));
            if (cn.b.comp === c.id && topY[cn.a.comp] != null && depth[cn.a.comp] < k) ys.push(pinY(cn.a));
          });
          bary[c.id] = ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : Infinity;
        });
        cc.sort((p, q) => bary[p.id] - bary[q.id]);
      }
      let y = M; cc.forEach(c => { topY[c.id] = y; y += boxH(c) + GAPY; });
    });
    // center each column vertically against the tallest one
    const colH = columns.map(cc => cc.length ? cc.reduce((s, c) => s + boxH(c) + GAPY, 0) - GAPY : 0);
    const maxH = Math.max(0, ...colH);
    columns.forEach((cc, k) => { const off = (maxH - colH[k]) / 2; cc.forEach(c => { topY[c.id] += off; }); });

    // pin sides: each pin exits toward the column its wires go to (majority vote)
    const vote = {};
    conns.forEach(cn => {
      const d = depth[cn.b.comp] - depth[cn.a.comp];
      const ka = pinKey(cn.a.comp, cn.a.index), kb = pinKey(cn.b.comp, cn.b.index);
      vote[ka] = (vote[ka] || 0) + (d >= 0 ? 1 : -1);
      vote[kb] = (vote[kb] || 0) + (d <= 0 ? 1 : -1);
    });
    const geo = {}; // "comp.index" -> {x, y, side}  (side: 1 = right edge, -1 = left)
    comps.forEach(c => {
      const x = M + depth[c.id] * (W + GAPX); c._x = x;
      pinEntries(c).forEach((p, i) => {
        const k = pinKey(c.id, i), v = vote[k];
        const side = v == null ? (depth[c.id] === 0 ? 1 : -1) : (v >= 0 ? 1 : -1);
        geo[k] = { x: side > 0 ? x + W : x, y: topY[c.id] + HDR + (i + 0.5) * PPITCH, side };
      });
    });

    // ---- diagram ----
    mount.appendChild(el('h2', null, 'Wiring diagram'));
    const wrap = el('div', { class: 'sticky-board' });
    const vbW = M * 2 + nCols * W + (nCols - 1) * GAPX, vbH = maxH + M * 2 + 12;
    const svg = mk('svg', { viewBox: `0 0 ${vbW} ${vbH}`, preserveAspectRatio: 'xMidYMid meet' });
    attachPanZoom(svg);
    a11ySvg(svg, spec);
    comps.forEach(c => {
      svg.appendChild(mk('rect', { x: c._x, y: topY[c.id], width: W, height: boxH(c), rx: 8, class: 'p2p-comp' }));
      const t = mk('text', { x: c._x + W / 2, y: topY[c.id] - 8, 'text-anchor': 'middle', class: 'glabel', fill: '#c084fc' });
      t.textContent = c.label || c.id; svg.appendChild(t);
      pinEntries(c).forEach((p, i) => {
        const g = geo[pinKey(c.id, i)];
        svg.appendChild(mk('circle', { cx: g.x, cy: g.y, r: 5, class: 'p2p-pin' }));
        const lt = mk('text', { x: g.x + (g.side > 0 ? -10 : 10), y: g.y, 'text-anchor': g.side > 0 ? 'end' : 'start', 'dominant-baseline': 'central', class: 'p2p-pinlabel' });
        lt.textContent = p.label; svg.appendChild(lt);
      });
    });
    conns.forEach((cn, i) => {
      const w = cn.w, key = w.color || 'sig', wc = col(key);
      const A = geo[pinKey(cn.a.comp, cn.a.index)], B = geo[pinKey(cn.b.comp, cn.b.index)];
      const bend = Math.max(56, Math.abs(B.x - A.x) * 0.45);
      const c1x = A.x + A.side * bend, c2x = B.x + B.side * bend;
      const pAttrs = { class: 'wire', 'data-id': w.id, d: `M${A.x},${A.y} C${c1x},${A.y} ${c2x},${B.y} ${B.x},${B.y}` };
      const dash = dashOf(key); if (dash) pAttrs['stroke-dasharray'] = dash;
      const p = mk('path', pAttrs);
      p.style.stroke = wc; wireTitle(p, w); svg.appendChild(p);
      // numbered step badge at the curve midpoint (t = 0.5 of the cubic)
      const mx = (A.x + 3 * c1x + 3 * c2x + B.x) / 8, my = (A.y + 3 * A.y + 3 * B.y + B.y) / 8;
      const bc = mk('circle', { cx: mx, cy: my, r: 9, class: 'p2p-badge', 'data-id': w.id }); bc.style.stroke = wc; svg.appendChild(bc);
      const bt = mk('text', { x: mx, y: my, class: 'p2p-badgetext' }); bt.textContent = i + 1; svg.appendChild(bt);
    });
    wrap.appendChild(svg);
    if (o.hints) wrap.appendChild(el('p', { class: 'hint' }, 'Wire badges = connection step numbers below. Hover (or tap) a table row — the wire highlights. Click to pin. Focus the diagram and use arrow keys to pan, + / − to zoom, 0 to reset.'));
    mount.appendChild(wrap);

    // ---- legend + per-component pinouts (what each module pin goes to) ----
    const gridDiv = el('div', { class: 'grid' });
    const left = el('div'), right = el('div');
    if (o.legend && spec.legend && spec.legend.length) {
      left.appendChild(el('h2', { style: 'margin-top:0' }, 'Legend'));
      spec.legend.forEach(lg => left.appendChild(el('div', { class: 'legend-row' }, `${swatchLine(lg.color)}${lg.label}`)));
    }
    (o.pinTables ? comps : []).filter(c => c.pinTable !== false && pinEntries(c).length).forEach(c => {
      right.appendChild(el('h2', { style: right.childNodes.length ? '' : 'margin-top:0' }, (c.label || c.id) + ' pinout'));
      const hasNotes = pinEntries(c).some(p => p.notes);
      const tbl = el('table'); let h = `<tr><th>Pin</th><th>Goes to</th>${hasNotes ? '<th>Notes</th>' : ''}</tr>`;
      pinEntries(c).forEach((p, index) => {
        const hits = [];
        conns.forEach((cn, i) => {
          const peer = cn.a.comp === c.id && cn.a.index === index ? cn.b : (cn.b.comp === c.id && cn.b.index === index ? cn.a : null);
          if (peer) hits.push(`<span class="swatch" style="background:${col(cn.w.color || 'sig')}"></span> #${i + 1} ${nameOf(byId[peer.comp])} <span class="pin">${peer.pin}</span>`);
        });
        h += `<tr><td class="pin">${p.label}</td><td>${hits.length ? hits.join('<br>') : '<span class="sub">—</span>'}</td>${hasNotes ? `<td>${p.notes || ''}</td>` : ''}</tr>`;
      });
      tbl.innerHTML = h; right.appendChild(scrollWrap(tbl));
    });
    gridDiv.appendChild(left); gridDiv.appendChild(right);
    mount.appendChild(gridDiv);

    // ---- ordered connection table (this IS the build order; spec order rules) ----
    // Optional `phase` on a net renders a section header when it changes.
    mount.appendChild(el('h2', null, 'Connections — in build order'));
    const tbl = el('table');
    tbl.innerHTML = '<thead><tr><th></th><th>#</th><th>From</th><th>To</th><th>Connection</th><th>Notes</th></tr></thead>';
    const tb = el('tbody'); let lastPhase = null;
    conns.forEach((cn, i) => {
      const w = cn.w;
      if (w.phase && w.phase !== lastPhase) { lastPhase = w.phase; tb.appendChild(el('tr', { class: 'phase' }, `<td colspan="6">${w.phase}</td>`)); }
      const wc = col(w.color || 'sig');
      const tr = el('tr', { class: 'wrow' });
      tr.innerHTML = `${swatchCell(w.label || w.id || `connection ${i + 1}`, wc)}
        <td>${i + 1}</td>
        <td>${nameOf(byId[cn.a.comp])} <span class="pin">${cn.a.pin}</span></td>
        <td>${nameOf(byId[cn.b.comp])} <span class="pin">${cn.b.pin}</span></td>
        <td>${w.label || w.id || ''}</td><td>${w.note || ''}</td>`;
      linkRow(tr, svg, w.id);
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); mount.appendChild(scrollWrap(tbl));

    footerMeta(mount, meta, o, svg, spec);
    return mount;
  }

  global.renderWiringGuide = renderWiringGuide;
  global.WiringValidationError = WiringValidationError;
  global.WiringGuide = { render: renderWiringGuide, renderPointToPoint, validate: validateSpec, normalizeSpec, PRESETS, PALETTE, PINOUTS, MODULES, WiringValidationError, accessibleHex };
})(typeof window !== 'undefined' ? window : this);
