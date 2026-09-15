# Can't-be-wrong — architecture

Status: **shipped**. This is the design/decision record for the semantic
pin-role validation layer.

## Why

A wiring guide that draws whatever the spec says is a wiring guide that can lie.
The motivating case: a sensor's power wire specified onto Raspberry Pi
physical **pin 15 (GPIO22)** instead of **pin 17 (3V3)**. A geometry-only
renderer draws it beautifully; the sensor browns out at ~1.5 V and looks dead.
An abstraction with no concept of "VCC must land on a power pin" will happily
draw that mistake.

North star: **the spec cannot render a lie.** Two pillars:

1. **Single-source pin labels** — the label drawn on the canvas and the pin shown
   in the tables are the same resolved value, so they physically cannot disagree.
2. **Semantic pin-role validation** — the library knows what each physical header
   pin *is* (3V3/5V/GND/GPIO, plus a board's raw regulator input and its
   reference pins), knows what each wire is *for* (declared or inferred role),
   and **refuses to render** any spec where the two conflict.

This is **coarse role checking, not complete electrical validation** — see
[Scope](#scope--coarse-role-checking-not-electrical-validation) below.

## Relationship to point-to-point mode

Validation builds on shared helpers used by both renderers (including the
warning-box pattern the error box extends), and the Pi-header use case that
motivated all of this is point-to-point (`pi.P17 3V3 → sensor.VCC`).
Validation is implemented mode-agnostically, so board-mode specs get the same
guarantees as point-to-point ones.

## Pillar 1 — single-source pin labels (perfboard mode)

Before: the SVG hole text came from component pin names, then `spec.labels`
**silently overwrote** it (`Object.assign`), while the pin tables read
`component.pins` directly. Two sources → a `labels` typo could draw "7" on a
hole the table called P9.

Now: one resolved map, `holeInfo` (`hole → {text, comp, pin}`), is built once
and read by **all three surfaces**:

- the SVG hole label draws `holeInfo[k].text`;
- the per-component pin table shows the pin name **plus** `drawn "…"` whenever
  the drawn text differs — pulled from the same entry;
- the wires table resolves each endpoint through `holeInfo`, so a hole that is a
  component pin is displayed *as that pin* (`pi P9 GND (2,5)`), never as a bare
  coordinate that could drift from the drawing.

`spec.labels` is demoted from "override" to "display shortening of the same
entry": it can change the drawn text of a pin's hole, but the pin identity stays
attached, and (for pinout-backed pins, below) a contradictory label is a hard
validation error:

```
label override "7" at hole (2,5): that hole is pi pin "P9 GND" = physical pin 9
— the canvas would show "7" while the table says 9
```

Point-to-point mode was already single-sourced (diagram, pinout tables, and
connection table all derive from the same resolved `conns`); it is unchanged.

## Pillar 2 — semantic pin-role validation

### The pinout map

`PINOUTS` (exported as `WiringGuide.PINOUTS`) maps a pinout id to
`{ label, source, verified, pins: { physicalPinNumber → function } }`.
`source` is one URL to the vendor document the map was checked against and
`verified` the date — provenance lives in the tree, not in git history. The
reference entry is `raspberry-pi-40`, the full 40-pin J8 header (identical
across all 40-pin Pis):

| class | physical pins |
|---|---|
| 3V3 | 1, 17 |
| 5V | 2, 4 |
| GND | 6, 9, 14, 20, 25, 30, 34, 39 |
| RESERVED (HAT ID EEPROM) | 27 (ID_SD), 28 (ID_SC) |
| SIGNAL (GPIO…) | everything else |

A function string (`"3V3(OUT)"`, `"GPIO2/SDA1"` — `/`-separated names, each
optionally annotated) is collapsed to a **pin class** by `fnClass`. Names are
matched **exactly** against a small vocabulary — no prefix guessing, so a
custom `VBUS_SENSE` is a signal, not the 5 V rail:

| pin class | function names | a net may land here when its role is… |
|---|---|---|
| `GND` | `GND` `AGND` `DGND` `GNDA` `GNDD` | `GND` |
| `3V3` | `3V3` `3.3V` | `3V3` or `POWER` |
| `5V` | `5V` `VBUS` | `5V` or `POWER` |
| `RAW` (internal) | `VIN` `VSYS` — the board's **own regulator input** | *no role.* A regulated `3V3` / `5V` / `POWER` net is refused; a roleless net (battery `+`, barrel jack) is not checked |
| `REF` (internal) | `AREF` `IOREF` `VREF` `ADC_VREF` — a **voltage reference** | *no role.* Any supply, ground or signal net is refused; a roleless net is not checked |
| `RESERVED` | `ID_*`, anything containing `RESERVED` | never |
| `SIGNAL` | anything else (`GPIO4`, `3V3_EN`, `RUN`, `EN`…) | `SIGNAL` |

`RAW` and `REF` are **internal pin classes only**. They are deliberately *not*
net roles — there is no `"role": "VIN"` or `"role": "REF"` (both are rejected as
unknown roles), and there is no `volts` field or per-pin voltage window
anywhere in the schema. The validator knows that Arduino `VIN` and Pico `VSYS`
are *not* the regulated 5 V rail and that a reference pin is *not* a supply;
it does not know what voltage they want. That is the whole model.

Why `VIN` is not simply "5V": the Uno's `VIN` is the input to its on-board
5 V regulator. A regulated 5 V supply wired into it under-feeds that regulator
and the board runs unstable — the mistake looks perfectly reasonable on a
diagram, which is exactly the class of lie this layer exists to refuse.

### Binding a component to a pinout

```jsonc
{ "id": "pi", "pinout": "raspberry-pi-40",
  "pins": [{"label":"P1 3V3"}, {"label":"P2 5V"}, {"label":"P9 GND"}, {"label":"P16 NSS"}, …],
  "pinNumbers": { "ODD NAME": 17 }                        // optional explicit positions
}
```

Each pin's **physical position** comes from `pinNumbers[name]` if present, else
from the leading `P<n>` / `<n>` of the pin name (the convention the specs already
use). Once a component is pinout-backed, its **definition** is audited:

- every pin must resolve to a physical position that exists on the header;
- no two pins may claim the same position;
- the pin's *name* may not lie: a name containing a power/ground token
  (3V3/5V/GND/VCC/…) on a pin whose real class differs is an error, and a
  power/ground pin **must** be named for what it is ("P20 SENSOR_EN" on the GND
  pin 20 is rejected) — a header can never disguise a power pin as a signal;
- a `GPIO<n>` in the name must match the header's GPIO number for that position.

### Declaring / inferring a wire's role

Roles: `3V3`, `5V`, `POWER` (either rail; `VCC` accepted as an alias), `GND`,
`SIGNAL`. Resolution order for a net:

1. explicit `"role": "3V3"` on the net;
2. `pinRoles: { "<pin>": "<role>" }` on a component (per-pin override);
3. inference from endpoint **pin names**: `3V3|3.3V → 3V3`, `5V|VBUS → 5V`,
   `GND|AGND|DGND|GNDA|GNDD|0V|V- → GND`, `VCC|VDD|V+|PWR|POWER → POWER`.
   Names are whole identifiers and `_` is part of a name (the same exact-name
   stance as `fnClass`): `P17 3V3` infers `3V3`, but `3V3_EN`, `VBUS_SENSE`
   and `VCC_EN` are single names that infer nothing — a control or sense line
   must never be mistaken for the supply it is named after. `VIN` is
   deliberately **not** a `POWER` token: on a board it is the raw regulator
   input and on a breakout it may be either, so inferring "3V3-or-5V rail"
   from it is the very mistake the `RAW` class exists to catch. A wire whose
   only power-ish name is `VIN` stays roleless and unchecked.

The two endpoints must agree — `pi.P1 3V3 → sensor.GND` is rejected outright
("the two ends disagree about what this wire is"), which catches swapped power
wires even with **no pinout declared**. `POWER` narrows against a specific rail
(`POWER` + `3V3` ⇒ `3V3`).

Ergonomics: with the existing naming conventions (`P17 3V3`, module pins named
`VCC`/`GND`), roles resolve automatically — most specs declare nothing extra.

### The hard check

For every net endpoint that lands on a pinout-backed pin: the net's resolved
role must be allowed on that pin's class
(`3V3→3V3`, `5V→5V`, `POWER→3V3|5V`, `GND→GND`, `SIGNAL→SIGNAL`; `RAW`, `REF`
and `RESERVED` appear in **no** role's list). Perfboard `[col,row]` endpoints
are reverse-resolved to component pins first, so both modes are covered. A net
with no resolved role is not checked against `RAW`/`REF` — the author owns the
goal there. Failure text is specific and tells you where to move the wire:

```
net PWR ("Pi P15 → BME280 VCC"): this is a POWER connection, but pi.P15 GPIO22
is physical pin 15 on the Raspberry Pi 40-pin GPIO header (J8) = GPIO22
(SIGNAL), not POWER. On this header, POWER lives on physical pins 1, 2, 4, 17.
```

and for the raw-input case:

```
net N1 (""): this is a 5V connection, but u.VIN is pin VIN on the Arduino Uno R3
(ATmega328P) = VIN (the raw supply input to the on-board regulator, not a
regulated rail), not 5V. On this header, 5V lives on pin 5V.
```

A pinout-backed pin's **name** is held to the same classes: a pin on a `RAW`
or `REF` position whose name carries a rail/ground token (or a rail/ground pin
whose name hides it) is a definition error, the same as for `3V3`/`5V`/`GND`.

### Failure semantics — it must not silently draw

`validateSpec(spec)` (exported as `WiringGuide.validate`) is pure (no DOM) and
returns `{errors, warnings}`. `renderWiringGuide` / `renderPointToPoint` call it
first; on any error they:

1. mount a visible **"✋ VALIDATION FAILED — N error(s). Nothing was drawn."**
   box (same `.warn` styling as the p2p unresolved-endpoint box) listing every
   error — nothing else is rendered;
2. `console.error` the plain-text errors;
3. **throw `WiringValidationError`** (with `.errors`) for programmatic callers.

The playground catches the throw and points at the box; the node harness
(`test/run-validation.js`) uses `WiringGuide.validate` directly.

### Backward compatibility

The *electrical* checks are **opt-in by content**: with no `pinout`, no
`module`, no `role` and no `pinRoles` anywhere in a spec, this layer has nothing
to check. The *structural* checks (known preset, on-board coordinates, resolvable
endpoints, unique ids — see `docs/spec.md` § Validation) always run: validation
fails closed, so a spec that cannot be drawn correctly is rejected rather than
rendered with a plausible-looking fallback.

## Scope — coarse role checking, not electrical validation

This layer exists to stop the overly-silly mistakes: a power wire on a GPIO, a
disguised ground, a regulated rail into a board's own regulator input, a supply
onto a reference pin, anything on a reserved pin. It is **not** an electrical
model:

- it does not know voltages, current limits, or pin direction — there are no
  voltage windows on pins and no `volts` on nets, by decision (unconfirmable
  numbers are not shipped as fact);
- it cannot catch a 12 V supply on a 5 V-only sensor, or a 3.3 V-only part fed
  from 5 V unless the spec narrows `POWER` to a rail;
- the reference pins are not interchangeable (`IOREF` is an output for shields
  to sense; `AREF` / `ADC_VREF` are inputs) — the validator only knows "not a
  supply";
- a roleless net into `VIN`/`VSYS` (a battery `+`, a barrel jack) is left to
  the author.

The guide is fully usable with no pinouts at all, and a board you define
yourself in the spec's `pinouts` map gets exactly the same coarse checks as a
built-in.

## Demonstration / verification

Exercised by `node test/run-validation.js` (what `npm test` and CI run):

- `specs/demo-pin15-vcc-wrong.json` — BME280 VCC on pin 15: **rejected**, error
  above, nothing drawn, `WiringValidationError` thrown (node + headless browser).
- `specs/demo-pin17-vcc-correct.json` — same build, VCC on pin 17: renders clean.
- `specs/demo-divider-adc.json` (board mode) validates clean and renders.
- Injecting a label desync (`"2,5": "7"` over a `P9 GND` hole) into a pinout-backed
  spec → rejected with the label-override error.
- Inline negative cases: mis-named power pin, disguised GND, wrong GPIO number,
  nonexistent pin, unresolvable position, explicit-role mismatch, cross-end
  disagreement, renumbering label, pinRoles override, reserved-pin use both with
  a resolved role and role-independently; a `5V`/`POWER` net into Uno/Nano `VIN`
  and Pico `VSYS` (explicit and name-inferred), a supply or signal onto
  `AREF`/`IOREF`/`ADC_VREF`, a `5V` rail onto a custom `VBUS_SENSE` function;
  `role: "VIN"` / `role: "REF"` rejected as unknown roles; a net-level `volts`
  buys no override; no built-in pinout ships a voltage window.
- Positive cases: a roleless battery `+` into `VIN` and a `GND`-named net into a
  ground pin pass; `3V3_EN` / `VBUS_SENSE` / `VCC_EN` accept signal nets.

## Known limits

- **Seven pinouts** ship built-in (`raspberry-pi-40`, `raspberry-pi-pico`,
  `arduino-uno-r3`, `arduino-nano-v3`, `esp32-devkitc-38pin`,
  `esp8266-nodemcu-v1`, `wemos-d1-mini`), each with an in-tree `source` URL;
  **any other board can be defined inline** via the spec-level `pinouts` map,
  so you're never blocked on a built-in.
- **Role-less signal nets are unchecked** — `pi.P3 SDA → nau.SDA` carries no
  power token, so nothing verifies SDA is on the I2C-capable pin. Function-level
  matching (SDA↔SDA1, SCK↔SCLK) is a natural next step but needs an alias table
  to avoid false rejections.
- Module-side pins (no pinout) are trusted: if a breakout's silkscreen itself is
  wrong, we can't know.
- `POWER` (generic VCC) accepts either rail — a 3.3-V-only sensor's VCC landing
  on a 5 V pin passes unless the spec narrows it (`"role": "3V3"` or
  `pinRoles: {"VCC": "3V3"}`). Declaring the module's real rail is cheap; do it.
- A roleless net into a `RAW` or `REF` pin is not checked (see Scope).
- Voltage/current limits, connector keying, wire gauge, and full net-tracing DRC
  remain out of scope (same stance as the light DRC).

## Future

- More built-in pinouts (`esp32-devkit-v1-30`, screw-terminal blocks with
  keying).
- Signal-function matching via an alias table (SPI/I2C/UART pin classes).
- A `--strict` mode where *every* net must resolve a role.
