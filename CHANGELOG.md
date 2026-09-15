# Changelog

All notable changes to wiring-guide. Format follows
[Keep a Changelog](https://keepachangelog.com/); versioning follows
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break the spec format).

## [Unreleased]

Public-release preparation. The findings referenced below (WG-01 … WG-10) are
from the independent pre-release review; each was fixed on its own branch and
the four branches were integrated and re-verified together.

### Fixed
- **Validation fails closed** (pre-release review WG-02): the pre-render gate
  now rejects an unknown `board.preset` (was: silent fallback to the 20×20
  default board), non-positive / non-integer / oversized board dimensions,
  bus runs that leave the grid, pin `loc`s / `span`s / `labels` keys / net
  endpoints that are off the board, `"component.pin"` net endpoints in board
  mode that do not resolve (was: `TypeError … reading 'join'` during render),
  a malformed electrocookie `boards` (non-integer, `{}`, or an object with an
  unknown key such as a typo'd axis; the undocumented `cols`/`rows` aliases
  inside `boards` are removed — `x`/`y` only), a resolved grid over 20 000 holes,
  and missing or duplicate component / net ids (docs already required them
  unique). Point-to-point mode now also **rejects** an unresolved endpoint or
  a non-coordinate pin `loc` instead of warning and dropping the connection.
  Every case is a `WiringValidationError` with a message naming the field.
  Reversed `span` corners and reversed `rails`/`segments` runs are normalized
  at render (no more negative-width rects).
- **Ids are a defined grammar** (pre-1.0 schema decision): component and net
  ids must be non-empty strings matching `^[A-Za-z0-9][A-Za-z0-9_-]*$`; every
  shipped spec already conforms. Id lookups are prototype-free, so `constructor`
  is a legal id and `__proto__` is rejected rather than misreported.
- **Non-array `meta.notes` no longer crashes render** (WG-08): it was a
  documented warning-only condition that `headerMeta` then `.forEach`-ed.
  The guide renders with the warning box and draws no notes.
- **Arduino `VIN` / Pico `VSYS` were classified as the `5V` rail.** They are now
  an internal *raw regulator input* class that no net role may land on: a
  regulated `3V3`/`5V`/`POWER` net wired into Uno/Nano `VIN` or Pico `VSYS` is
  refused (a 5 V supply into an Uno `VIN` under-feeds its 5 V regulator), while
  a roleless raw supply (battery `+`, barrel jack) is left to the author.
  `AREF`/`IOREF`/`ADC_VREF` are an internal *reference* class — a supply,
  ground or signal net onto one is refused. Pin function names are now matched
  exactly instead of by prefix (a custom `VBUS_SENSE` is a signal, not 5 V),
  and endpoint pin-name inference treats `_` as part of the name the same way
  (`3V3_EN`, `VBUS_SENSE`, `VCC_EN` infer nothing; `3V3`/`5V`/`GND`/`VCC`
  still do). `VIN` is no longer a `POWER` name token. Net roles are unchanged (`3V3` ·
  `5V` · `POWER` · `GND` · `SIGNAL`). This remains **coarse** role checking,
  not electrical validation — see `docs/spec.md`.
- Pico pinout note widened: non-wireless Pico 2 shares the original Pico pinout
  (Raspberry Pi docs); only the W boards differ.
- **Themed root paints its own background** (WG-01): `.wg` now sets
  `background: var(--bg)` and declares `color-scheme` per theme, so the
  README's minimal embed on an unstyled host page is readable in both themes
  (was: light text over the host's white). The theme is honored on the
  validation-failure path too — a mount that rendered light and then fails
  asking for dark drops `.wg-light` and paints the dark error box.
- **Playground editor on a phone viewport** (WG-04): the page is a flex
  column, the toolbar wraps, and the single-column layout gives the JSON
  editor an explicit `minmax(280px, 45vh)` row (was: `.spec-wrap` measured
  390×0 px at 390×844 and the document scrolled horizontally).
- **Interactive controls are real buttons** (WG-06): `aria-pressed` / focus
  live on a `<button>` inside the wires-table swatch cell (rows keep table
  semantics) and inline build-step references are `<button class="wref">`;
  axe `aria-allowed-attr` is now zero. A separate per-theme **text palette**
  (≥ 4.5:1 against both `--bg` and `--panel`) colors inline references, and
  author hex colors used as text are normalized to opaque 6-digit hex and
  luminance-nudged to AA on the theme panel — drawing strokes keep the
  author's exact color. Pin/unpin state stays consistent across every control
  of a net (row button ↔ build-step reference).
- **Playground favicon** (WG-10): inline SVG data-URL icon; no more 404.
- **Standalone export serialization** (WG-07): the playground's "Download
  standalone HTML" interpolated `meta.title` unescaped into `<title>` and the
  spec's `JSON.stringify()` unescaped into an inline `<script>`; a spec field
  containing a script-closing string could terminate the script element early
  and break the exported file. The title is now HTML-escaped and the embedded
  JSON has its less-than signs escaped as a Unicode escape (round-trips through
  `JSON.parse` unchanged). Covered by `test/export-safety.js` (node) and the
  real-download check in `test/browser-smoke.js`.
- **Doc accuracy** (WG-05, WG-09): `templates/README.md` and the design notes
  no longer claim only two built-in pinouts; the changelog no longer claims
  point-to-point `pins` may be a plain array of names (the validator requires
  `{ label }` objects); the README's first spec-shape block is labelled as
  illustrative JSONC with a paste-runnable JSON example beside it.

### Added
- **Real-browser smoke suite** (`npm run test:browser`, `test/browser-smoke.js`):
  headless Chromium via Playwright (self-skips when not installed; axe-core
  optional) — white-host embed in both themes, 390×844 playground layout,
  favicon/404s, ARIA-on-buttons, axe color-contrast + aria-allowed-attr = 0,
  adversarial author hex as reference text, cross-control pin state, theme
  on the error path, and real HTML parsing of the playground plus a real
  "Download standalone HTML" click whose file is reopened from `file://` and
  must render without executing injected script. CI runs it with
  `BROWSER_SMOKE_REQUIRED=1` so a missing browser or axe is a failure, not a
  skip.
- **In-tree pinout provenance**: every built-in pinout carries `source` (one
  URL to the vendor datasheet/doc it was verified against) and `verified`
  (date), exposed as `WiringGuide.PINOUTS[id].source`, so citations survive a
  history-free publish.
- **Common breakout modules** (`"module": "hc-sr04"`) — reference a discrete
  sensor/peripheral by name and its canonical pins arrive with electrical roles
  attached, so validation catches a power pin wired to a signal with zero
  hand-annotation. Ships `hc-sr04`, `dht22`/`am2302`, `dht11`, `ds18b20`,
  `mpu6050`, `ssd1306-oled`/`ssd1306`, `bme280`, `pn532-i2c`/`pn532`
  (`WiringGuide.MODULES`); worked example `specs/hc-sr04-arduino-distance.json`.
  Author `pins`/`pinRoles`/`label` override the defaults; a part is a `module`
  **or** a `pinout`, not both.
- **Accessibility — keyboard pan/zoom**: the board SVG is now focusable
  (`tabindex=0`, `aria-keyshortcuts`, visible focus ring) and pan/zoom is
  driveable from the keyboard — arrow keys pan (Shift = coarse), `+`/`-` zoom
  about center, `0` resets — over the same viewBox the pointer path uses.
- **Accessibility — colorblind-safe pattern-per-role**: each wire role gets a
  distinct stroke dash (power solid / ground dotted / signal dashed / node
  dash-dot) layered on top of its color; the legend swatch shows the same
  color+pattern line and each wire `<title>` names its role in words.
- feat(#10): per-component colors (fill, border, pin, label) via optional `colors` object.
- **Point-to-point mode** (`"mode": "point-to-point"`) — no-board wiring:
  module pins soldered straight to each other or a header, rendered as a
  hub-and-spoke diagram with a numbered, phase-grouped connection table that is
  the build order. Net endpoints as `"component.pin"` strings; `pins` is an
  array of `{ label, notes? }` objects (order = physical header/drawing order).
- **Can't-be-wrong validation** — opt a component into a physical `pinout`
  (`raspberry-pi-40` ships) and the renderer validates every pin and wire
  against the real header and **refuses to render** on a mismatch (misnamed
  power pin, disguised ground, label that renumbers a pin, two-ends-disagree
  wire, wrong electrical role for a pin, or any wire to a reserved pin). Pure,
  DOM-free `WiringGuide.validate(spec)`; exercised by `test/run-validation.js`.
- Neutral demo specs: `demo-divider-adc.json` (board mode),
  `demo-pin17-vcc-correct.json` / `demo-pin15-vcc-wrong.json` (point-to-point +
  the validation regression).
- `docs/spec.md` full spec reference; `CONTRIBUTING.md`; `docs/design/` notes;
  gitea Actions CI (`.gitea/workflows/ci.yml`).

### Changed
- Decoupled the library from its original internal uses: removed project-specific
  example specs and scrubbed all internal references, so the library stands alone.
- **Release-hygiene sweep** (WG-05): design notes are present-tense
  architecture/decision records (no `DRAFT` / private-branch markers, no named
  `TODO`s), the regression example is described neutrally, pinout comments
  make no numeric voltage claims, and every built-in pinout's provenance is in
  the tree (`source` / `verified`) rather than in git history.
- **Pinout function names match exactly** (part of the WG-03 fix above): a
  function is classified by whole name, not prefix. A custom `pinouts` entry
  that relied on prefix matching (`"5V_OUT"` → 5V) now classifies as `SIGNAL`;
  name the pin `5V` (aliases: `"5V/5V_OUT"`) to keep the rail class. The
  undocumented `cols`/`rows` aliases inside an electrocookie `boards` object
  are removed (`x`/`y` only).

## [0.1.0] — 2026-07-06

First spec-driven release: everything the hand-coded per-project
`wiring.html` guides could do, from a JSON spec.

### Added
- `wiring.js` — the declarative renderer (`renderWiringGuide(spec, el)`):
  SVG board map, color-coded nets (jumper / resistor / diode / cap),
  hover/click-linked wire table, component outlines + pin tables, legend,
  build order, and pre-power checks. Vanilla JS, CSS-injecting,
  self-contained.
- Board presets with real geometry: `electrocookie-strip` (grid-arrangeable
  via `boards`), `breadboard-mini` / `-half` / `-full`, `perf` and the common
  `perf-4x6cm` / `-5x7cm` / `-7x9cm` sizes. Orientation-aware bus runs
  (`{row,c0,c1}` / `{col,r0,r1}`) for rails and field segments.
- Light DRC: same-hole lead-collision warnings, with `socket: true` marking
  plug-in parts whose pin holes a wire may legitimately share.
- `index.html` playground: JSON editor, live preview, standalone-HTML export.
- A worked board-mode example (a 2-channel voltage divider → ADC) and a
  point-to-point example.
- MIT license.
