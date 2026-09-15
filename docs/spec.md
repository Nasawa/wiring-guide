# Wiring-guide spec reference

Everything `renderWiringGuide(spec, el)` understands, field by field. The spec
is plain JSON; all top-level sections are optional — an empty spec renders an
empty 20×20 perf grid.

```jsonc
{
  "mode":       "point-to-point",  // optional — omit for board mode (default)
  "board":      { … },   // geometry: preset or explicit grid
  "components": [ … ],   // outlined parts with named pins
  "labels":     { … },   // short text overrides for holes
  "nets":       [ … ],   // wires / resistors / diodes / caps
  "legend":     [ … ],   // color swatch + description rows
  "meta":       { … },   // title, intro, notes, build order, checks
  "options":    { … },   // display/render toggles (also settable per-render)
  "pinouts":    { … }    // define your own board pinouts for validation
}
```

**Coordinates** are `[col, row]`, **1-indexed**, col 1 = left, row 1 = top.

**HTML**: `meta.intro`, `notes[].html`, `buildOrder[]`, `checks[]`, legend
labels, and net `label`/`note`/`value` are injected as HTML — `<strong>` etc.
work. That also means specs are **trusted input**; don't render JSON from
sources you don't trust.

## `board`

Either a preset:

```jsonc
{ "preset": "electrocookie-strip", "boards": { "x": 2, "y": 1 } }
```

or an explicit grid:

```jsonc
{ "cols": 22, "rows": 23, "rails": [ … ], "segments": [ … ] }
```

`rails` / `segments` supplied alongside a preset **override** the preset's own.
Defaults with no preset: `cols: 20`, `rows: 20`, no buses.

The board is validated before anything is drawn: an unknown `preset`, a
`cols`/`rows` that is not a positive whole number, a malformed electrocookie
`boards` (see the preset table), a
resolved grid over 1000 on either axis **or over 20 000 holes in total**, or a
bus run that leaves the grid is a **validation error** (nothing renders) —
never a silent fallback to the default board. Run ends (`c0`/`c1`, `r0`/`r1`)
may be given in either order; the renderer normalizes them.

### Bus runs (`rails` and `segments`)

Both are lists of orientation-aware runs:

| shape | meaning |
|---|---|
| `{ "row": r, "c0": a, "c1": b }` | horizontal run on row *r*, cols *a…b* |
| `{ "col": c, "r0": a, "r1": b }` | vertical run on col *c*, rows *a…b* |

`segments` draw as dark field-bus slabs; `rails` draw as teal power-rail slabs
and accept an optional `"label"` (drawn at the head of the run; defaults to
`"rail"`). Buses are **visual documentation** of the board's copper — the
renderer does not electrically trace them (see “Light DRC” below).

### Presets

| preset | grid | buses |
|---|---|---|
| `electrocookie-strip` | 17×19 per board | rails on the outer columns (cols 1 & 17, rows 3–17) of each board; field = five horizontal 3-hole runs per row (cols 2–4, 5–7, 8–10, 11–13, 14–16). `boards` sets the arrangement: a positive whole number `n` = *n*×1 horizontal, or `{ "x": n, "y": m }` = a grid (each board offsets by 17 cols / 19 rows). The object form must name at least one axis — a missing axis is 1 — and may contain **no other keys**: `{}`, `{ "xx": 2 }` and `{ "x": 2, "yy": 3 }` are validation errors, so a typo'd axis never silently defaults. `x`/`y` are the only spellings (no `cols`/`rows` aliases). |
| `perf` | `cols`/`rows` (default 20×20) | none — every hole isolated |
| `perf-4x6cm` | 15×24 default | none. Hole counts vary by maker — override `cols`/`rows`. |
| `perf-5x7cm` | 18×24 default | none |
| `perf-7x9cm` | 24×36 default | none |
| `breadboard-mini` | 17 (override `cols`) × 11 | 170-pt: vertical 5-hole strips, rows 1–5 (a–e) and 7–11 (f–j), ravine at row 6. No power rails. |
| `breadboard-half` | 30 (override `cols`) × 17 | 400-pt: top rails rows 1 (−) & 2 (+), strips rows 4–8 (a–e) and 10–14 (f–j), ravine row 9, bottom rails rows 16 (+) & 17 (−). |
| `breadboard-full` | 63 (override `cols`) × 17 | 830-pt: same row map as `breadboard-half`. |
| `jumperless` / `jumperless-v5` | 30 (override `cols`) × 17 | Jumperless V5 software-defined breadboard: 30 five-hole strips per half. Each strip is stamped with its **routing node number** (top half 1–30, bottom half 31–60 = col + 30) in place of the generic column/row axes; rails are labeled `TOP_RAIL` / `BOTTOM_RAIL` / `GND`. |

## `components[]`

```jsonc
{
  "id": "esp",                          // required — used in DRC messages
  "label": "ESP32 DevKit V1 (30-pin)",  // drawn on the board + pin-table heading
  "span": [[13, 3], [22, 17]],          // dashed outline, [topLeft, bottomRight]
  "pins": [
    { "label": "GPIO34", "loc": [13, 6], "notes": "ADC input" },
    { "label": "GND", "loc": [13, 16] }
  ],
  "socket": true,                       // plug-in part (see DRC)
  "pinTable": false,                    // suppress this component's pin table
  "pinout": "raspberry-pi-40",          // opt into can't-be-wrong validation
  "module": "hc-sr04",                  // OR: a common breakout (pulls in pins+roles)
  "pinRoles": { "PWR_EN": "SIGNAL" }    // per-pin electrical-role override
}
```

- `span` — optional dashed outline. The `label` is centered inside it, or
  drawn just **above** the outline when the span is ≤ 1 row tall (short parts
  like screw terminals). Both corners must be holes on the board; they may be
  given in either order (the renderer normalizes).
- `id` — required and **unique** across `components`. Ids are plain strings
  matching `^[A-Za-z0-9][A-Za-z0-9_-]*$` (start with a letter or digit, then
  letters, digits, `_`, `-`; no spaces, dots or quotes — ids are used inside
  `"component.pin"` endpoint strings, `[data-id]` selectors and build-step
  word-boundary matching). A missing, non-string, malformed or duplicate id is
  a validation error.
- `pins` — always an array of pin objects. `label` is a required string and is
  the pin name; duplicate labels are allowed (for example, a board can have
  several `GND` pins). In board mode `loc` is a required `[col, row]` hole
  coordinate of whole numbers **on the board** (an off-board hole is a
  validation error). In point-to-point mode `loc` is optional and not drawn,
  but when present it must still be a `[col, row]` pair of whole numbers: it is
  the reverse-lookup key that lets `[col, row]` net endpoints from a board spec
  resolve to this pin (a non-coordinate `loc` is a validation error); array order
  determines the drawn pin position. `notes`, when present, is a string shown in
  that pin's table row. Each board-mode pin hole gets a white ring + its label;
  long labels can use a short override in `labels`.
- `socket: true` — declares a plug-in part (male header into a female socket):
  a single wire leg may share its pin's hole without tripping the DRC, because
  the wire is soldered under the socket, not fighting the pin for the hole.
  Leave through-hole parts (screw terminals, sensors soldered directly)
  without it.
- `pinTable: false` — keeps the pins/labels on the board but skips the table.
- `pinout` — bind the component to a known board to opt into
  **can't-be-wrong validation** (below): pin names and wire roles are checked
  against the real board and the guide *refuses to render* on a mismatch. How a
  pin resolves depends on the board's addressing (see `pinouts`): **numbered**
  headers (Pi/Pico) use the leading `P<n>`/`<n>` of each pin's `label`;
  **label** boards (Arduino/ESP) match the pin's `label` to a silkscreen label
  or any of its aliases. The value names either a **built-in** pinout or one you
  define in the spec-level `pinouts` map (below), so any board can be validated
  without waiting on a built-in. Built-ins (`WiringGuide.PINOUTS`):
  `raspberry-pi-40`, `raspberry-pi-pico` (numbered); `arduino-uno-r3`,
  `arduino-nano-v3`, `esp32-devkitc-38pin`, `esp8266-nodemcu-v1`, `wemos-d1-mini`
  (label-addressed).
- `module` — bind the component to a **common breakout** (see [Modules](#modules)).
  Unlike a `pinout` (a pin-numbered *header*), a module is a small fixed part
  addressed by silkscreen label: naming it pulls in the module's canonical pins
  **and** their electrical roles, so validation catches (say) 5V on a signal pin
  with zero hand-annotation. You supply just `{ "id": …, "module": "hc-sr04" }`
  — the pins appear automatically. A component may declare a `module` **or** a
  `pinout`, not both. Your own `pins`, `pinRoles`, and `label` override the
  module's defaults (e.g. add `loc`s to place it on a board).
- `pinNumbers` — `{ "ODD NAME": 17 }`, optional explicit physical-position map
  for pins whose name doesn't start with a number.
- `pinRoles` — `{ "PIN NAME": "SIGNAL" }`, optional per-pin electrical-role
  override (`3V3` · `5V` · `POWER` · `GND` · `SIGNAL`) for when a pin's name
  would otherwise mis-infer its role (e.g. `PWR_EN` is a signal, not power).

## `labels`

```jsonc
{ "13,6": "34", "1,16": "G" }
```

Map of `"col,row"` → short display text for that hole. Applied **after**
component pin names, so it doubles as a shortener for long pin names. Labeled
holes (from pins or `labels`) render with a white ring and the text centered
in the hole. Every key must name a hole on the board (validation error
otherwise).

## `nets[]`

One entry per wire or 2-lead part:

```jsonc
{ "id": "S1", "kind": "jumper", "from": [7,5], "to": [13,6],
  "color": "sig", "label": "NODE1 → GPIO34", "value": "", "note": "…" }
```

| field | meaning |
|---|---|
| `id` | required, **unique** — links the drawing to its table row for hover/click highlight (`data-id`). Same grammar as component ids (`^[A-Za-z0-9][A-Za-z0-9_-]*$`); a missing, malformed or duplicate id is a validation error. |
| `kind` | `jumper` (default) straight wire · `resistor` zigzag · `cap` zigzag · `diode` straight line **with the cathode band drawn at the `to` end** — point `to` at the cathode. |
| `from`, `to` | `[col, row]` hole coordinates, **or** `"component.pin"` strings (point-to-point mode, or to address a named component pin in board mode). Each end must resolve in **both** modes — an off-board hole, a `[col, row]` that is no pin's `loc` (point-to-point), or a reference to a component/pin that does not exist is a validation error. A guide never silently omits a requested connection. |
| `color` | palette key or `#hex` (below). Defaults: `r` for resistor/cap, `d` for diode, `sig` otherwise. |
| `label` | wire name in the table (falls back to `id`). |
| `value` | part value, e.g. `"10 kΩ"` / `"1N5819"` — the table's *Part* column (falls back to `kind`). |
| `note` | free-form table note (HTML ok). |
| `role` | optional electrical role for **validation** (`3V3` · `5V` · `POWER` · `GND` · `SIGNAL`); usually inferred from the endpoint pin names, set explicitly to override. Both ends must agree. |

Hovering (or tapping) a table row highlights the drawn element; clicking pins
the highlight.

### Colors

`color` anywhere (nets, legend) is either a raw `#hex` or one of:

| key | color | conventional use |
|---|---|---|
| `in` | `#ef4444` red | live input / V+ |
| `node` | `#f97316` orange | intermediate node ties |
| `gnd` | `#3b82f6` blue | ground |
| `sig` / `signal` | `#eab308` yellow | signals |
| `r` / `res` | `#b45309` brown | resistors |
| `d` / `diode` | `#10b981` green | diodes |
| `cap` | `#06b6d4` cyan | capacitors |

Unknown keys fall back to gray (`#8b949e`). The map is exposed as
`WiringGuide.PALETTE`.

## `legend[]`

```jsonc
{ "color": "sig", "label": "NODE → ESP ADC (GPIO34 / GPIO35)" }
```

Swatch + description rows, rendered beside the component pin tables. Purely
documentation — legend colors aren't checked against net colors.

## `meta`

```jsonc
{
  "title": "…",                 // <h1>
  "intro": "…",                 // subtitle paragraph
  "notes": [ "a plain neutral note", { "type": "warn", "html": "a caution" } ],
  "buildOrder": [ "…", "…" ],   // numbered steps, open by default
  "checks": [ "…" ]             // pre-power checks, collapsed by default
}
```

- `notes[]` — each note is **either a plain string** (renders as a neutral box)
  **or** an object `{ "html": "…", "type": "ok" | "warn" | "note" }`. `type` picks
  the style: `"ok"` = green, `"warn"` = red, `"note"` or omitted = neutral. Strings
  are the forgiving common case and never render empty; `WiringGuide.validate`
  **warns** (never fatally) on a malformed note — e.g. an object missing `html`,
  which previously rendered as a silent empty bar. A `notes` value that is not
  an array at all (say, a bare string) is the same kind of warning: the guide
  still renders, the warning box says why, and **no** notes are drawn.
- `buildOrder` / `checks` — arrays of HTML strings rendered as numbered /
  plain steps inside `<details>` sections.

## Light DRC (duplicate-hole check)

At render time every spec gets a cheap physical-collision pass: a hole is a
hazard when **≥ 2 physical things want it** — two or more net legs, or a net
leg on a **non-socket** component pin. Hazards produce a red warning box above
the board (listing hole + colliding refs) and a `console.warn`.

This is deliberately the cheap subset: the renderer does **not** trace bus
runs or check electrical connectivity — full net-tracing DRC is out of scope.
The idiom for sharing a bus with a screw-terminal pin is to land the wire in
an **adjacent hole of the same run**, not in the pin's hole.

## `options`

Display / render toggles. Can live on the spec **or** be passed as the third
argument to `renderWiringGuide(spec, el, options)`; they resolve as
**defaults ← `spec.options` ← the argument** (the argument wins). Every default
matches the standard full guide.

```jsonc
{ "pinTables": true, "legend": true, "buildOrder": true,
  "checks": true, "drc": true, "hints": true, "theme": "dark" }
```

- `pinTables` / `legend` / `buildOrder` / `checks` — show/hide those sections.
- `drc` — the light collision / stacked-joint overlay.
- `hints` — the "hover a row" interaction hint text.
- `theme` — `"dark"` (default) or `"light"`; a fully themed light palette
  (board colors included, via CSS custom properties on the mount).

The can't-be-wrong **validation is not an option** — it's the core guarantee.

## `pinouts`

Define your own physical headers so **any** board can opt into validation without
a built-in. A component's `pinout` resolves to a spec `pinouts` entry first, then
a built-in (`WiringGuide.PINOUTS`), so you can also shadow a built-in.

```jsonc
{
  "pinouts": {
    "my-board": {
      "label": "My Board header",              // optional (defaults to "<key> header")
      "pins": { "1": "3V3", "2": "GPIO0", "3": "GND", "4": "5V" }
    }
  },
  "components": [ { "id": "b", "pinout": "my-board", "pins": [{ "label": "P1 3V3" }, { "label": "P2 GPIO0" }] } ]
}
```

Each `pins` entry is `"<key>": "<function>"` — one or more `/`-separated names,
each optionally annotated `(…)` (`"3V3(OUT)"`, `"GPIO2/SDA1"`). Names are matched
**exactly** (no prefix guessing — a custom `VBUS_SENSE` is a signal, not the 5 V
rail) and collapse to a role class:

| function name | class | a net may land here when its role is… |
|---|---|---|
| `GND` `AGND` `DGND` `GNDA` `GNDD` | `GND` | `GND` |
| `3V3` `3.3V` | `3V3` | `3V3` or `POWER` |
| `5V` `VBUS` | `5V` | `5V` or `POWER` |
| `VIN` `VSYS` | raw regulator **input** | *no role* — a regulated `3V3`/`5V`/`POWER` net is refused; a roleless net (a battery `+`, a barrel jack) is not checked |
| `AREF` `IOREF` `VREF` `ADC_VREF` | voltage **reference** | *no role* — any supply/ground/signal net is refused; a roleless net is not checked |
| `ID_*`, anything containing `RESERVED` | `RESERVED` | never — wiring to it is refused |
| anything else (`GPIO4`, `3V3_EN`, `RUN`, `EN`…) | `SIGNAL` | `SIGNAL` |

Endpoint pin *names* infer a net role the same exact-name way: a pin named `3V3`,
`5V`, `GND` or `VCC` (or `P1 3V3` — the leading `P<n>` is a separate word) infers
its role; `3V3_EN`, `VBUS_SENSE` and `VCC_EN` are single names and infer nothing,
so a signal net on them is fine. Underscore is part of the name.

**This is coarse role checking, not electrical validation.** It exists to stop the
overly-silly mistakes — a regulated 3V3/5V rail wired into a board's raw regulator
input (Arduino `VIN`, Pico `VSYS`), a supply wired onto a reference pin, a power
wire on a GPIO, a wire to a reserved pin. It does not know voltages, current
limits, or pin direction, and it will not catch every voltage mismatch (a 12 V
supply on a 5 V-only sensor is invisible to it). The reference pins in particular
are *not* interchangeable (`IOREF` is an output for shields to sense; `AREF` and
`ADC_VREF` are inputs) — the validator only knows "not a supply". The author owns
the goal; the guide is usable with no presets at all, and a board you define
yourself in `pinouts` gets exactly the same coarse checks.

Every built-in pinout also carries `source` — a single URL to the vendor datasheet
or official doc it was verified against — and a `verified` date
(`WiringGuide.PINOUTS[id].source`).

### Addressing modes (`addressing`)

- **Numbered** (default, e.g. Pi/Pico): keys are physical pin numbers
  (`"1"`, `"2"`, …). A component pin resolves via the leading `P<n>`/`<n>` of its
  `label` (or an explicit `pinNumbers` map).
- **Label** (`"addressing": "label"`, e.g. Arduino/ESP): keys are silkscreen
  labels, and a key may list `/`-separated **aliases** — every alias resolves the
  same pin. So `"D2/GPIO4": "GPIO/I2C-SDA"` is reachable as `"D2"`, `"GPIO4"`, or
  `"D2/GPIO4"`. This is how boards nobody numbers by hand (you say `D13`, `A0`,
  `GPIO21`, `5V`) get validated — including the ESP8266 D-label≠GPIO trap.

```jsonc
{ "pinouts": { "my-esp": { "label": "My ESP", "addressing": "label",
    "pins": { "D2/GPIO4": "GPIO/I2C-SDA", "3V3": "3V3", "GND": "GND" } } } }
```

## Modules

A **module** is a common breakout — a 3–6-pin sensor/peripheral (HC-SR04,
DHT22, SSD1306…) addressed by silkscreen label with a fixed electrical role per
pin. Where a `pinout` describes a pin-numbered *header* you place parts onto, a
`module` **is** the part: reference it and its pins appear with roles attached,
so the [validator](#validation-cant-be-wrong) catches a power pin wired to a
signal (or vice-versa) without any per-pin annotation.

```jsonc
{ "id": "sonar", "module": "hc-sr04" }   // → pins VCC/TRIG/ECHO/GND, roles set
```

- Author-supplied `pins`, `pinRoles`, and `label` override the module defaults —
  e.g. add `loc`s to place the module on a board, or a `pinRoles` tweak.
- A component uses a `module` **or** a `pinout`, never both.
- `VCC` is `POWER` (accepts 3V3 or 5V) unless the part demands a specific rail
  (HC-SR04's `VCC` is `5V`); every data/clock line is `SIGNAL`; `GND` is `GND`.

Built-ins (`WiringGuide.MODULES`): `hc-sr04`, `dht22` (alias `am2302`), `dht11`,
`ds18b20`, `mpu6050`, `ssd1306-oled` (alias `ssd1306`), `bme280`, `pn532-i2c`
(alias `pn532`). Worked example: [`specs/hc-sr04-arduino-distance.json`](../specs/hc-sr04-arduino-distance.json).

## Validation (can't-be-wrong)

Every render runs a pure `WiringGuide.validate(spec)` pass first and **refuses
to draw** on any error — a red "VALIDATION FAILED" box plus a thrown
`WiringValidationError` (the node harness runs the same pass headlessly).
Validation **fails closed**: a spec that cannot be drawn correctly is rejected
rather than rendered with a plausible-looking fallback.

### Structural checks (every spec)

- `components` / `nets` must be arrays of objects; every entry needs a
  **unique** string `id` matching `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
- Board mode: `board.preset` must be a known preset; `cols`/`rows` must be
  positive whole numbers; an electrocookie `boards` must be a positive whole
  number or an `{ x, y }` object with at least one axis and no unknown keys;
  the resolved grid
  must be ≤ 1000 per axis and ≤ 20 000 holes; explicit `rails`/`segments`
  runs must lie inside the grid.
- Board mode: every pin `loc`, `span` corner, `labels` key, and `[col, row]`
  net endpoint must be a hole on the board.
- Both modes: every `"component.pin"` / `{ comp, pin }` net endpoint must name
  an existing component and pin; in point-to-point mode a `[col, row]` endpoint
  must be some pin's `loc`, and any pin `loc` given must be a coordinate pair.

### Can't-be-wrong (opt-in electrical checks)

Only components with a `pinout` or `module` (and/or nets with a
`role` / `pinRoles`) get the electrical checks; a spec with none passes on the
structural checks alone. When on, it catches:

- a pin **name that misstates its function** (`"P15 3V3"` — physical pin 15 is
  GPIO22), and a power/ground pin **disguised** as a signal;
- a `labels` override that would **renumber** a pin;
- a wire whose **two ends disagree** about what it is (e.g. `3V3 → GND`);
- a wire whose electrical **role doesn't match the physical pin** it lands on;
- any wire to a **reserved pin** (the Pi HAT ID EEPROM on pins 27/28, or the
  ESP32's flash-only GPIO6–11), regardless of role.

Roles resolve from an explicit net `role`, then a component `pinRoles` entry,
then inference from pin names (`3V3`/`5V`/`GND`/`VCC`/…). See
`docs/design/cant-be-wrong.md` for the full model.

## Accessibility

The diagram is an SVG; its **canonical text equivalent** is the wires + pin
tables, which list every connection independent of the drawing. On top of that:

- The board SVG is `role="img"` with a `<title>` (the spec title) and a `<desc>`
  (the intro plus a pointer to the tables), so a screen reader announces it and
  it degrades to meaningful text when images don't load.
- Every drawn wire carries a `<title>` (its label/id) — a wire is identifiable
  **without relying on color**, the redundant channel colorblind users need.
  Point-to-point mode additionally numbers each wire with a badge matching its
  table row.
- The wires-table rows and inline wire-refs are **keyboard-operable**: focusable
  (`tabindex=0`), Enter/Space toggles the highlight/pin, focus mirrors hover, the
  pinned state is exposed via `aria-pressed`, and `:focus-visible` shows position.
- The board SVG is **keyboard pan/zoom operable**: it is focusable (`tabindex=0`,
  `aria-keyshortcuts`, visible `:focus-visible` outline) and the same viewBox that
  the pointer/wheel gestures drive is reachable from the keyboard — arrow keys pan
  (Shift = coarse step), `+`/`-` zoom about the center, `0` resets (mirrors the
  double-click reset). Pan/zoom is no longer mouse/touch-only.
- Wire **roles carry a colorblind-safe pattern**, not color alone: each role gets a
  distinct stroke dash — power solid, ground dotted, signal dashed, node dash-dot —
  layered on top of (not replacing) its color, and the legend swatch shows the same
  color+pattern line. Component kinds (resistor/diode/cap) stay solid because their
  shape already encodes them. Every wire `<title>` also names its role in words, so
  the role survives with both color and pattern stripped.

## Rendering guarantees & quirks

- The mount element is cleared (`innerHTML = ''`) and gets the `wg` class; all
  injected CSS is scoped under `.wg`.
- The stylesheet is injected once per document (`<style id="wg-css">`).
- The board map is `position: sticky`, so it stays visible while scrolling the
  wire table.
- Column guide-numbers render every 2 cols, row numbers every 2 rows — except
  boards that carry their own per-strip node labels (Jumperless), which suppress
  the generic axes in favor of node numbers.
