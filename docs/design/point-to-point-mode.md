# Point-to-point mode — architecture

Status: **shipped**. This is the design/decision record for `spec.mode: "point-to-point"`.

## Why

The perfboard mode assumes everything lands on a grid. But some builds are true
point-to-point: module pins soldered straight to a Pi header or to each other, no board
at all. Board mode could only *fake* this — placing "holes" on a fictional perf grid
purely so the renderer has coordinates — which forces the author to invent geometry that
doesn't exist and makes the guide *look* like a board build when it isn't.

Point-to-point mode drops the grid: components are pin headers, connections are direct
`component.pin → component.pin` wires, and the guide's core artifact is a **numbered,
phase-grouped connection table** ("connect X pin A to Y pin B") plus a matching diagram.

## One spec, two modes

Opt in with a single top-level field; everything else is the same schema:

```jsonc
{
  "mode": "point-to-point",          // absent or anything else → perfboard mode
  "components": [ ... ],
  "nets": [ ... ],
  "legend": [ ... ],                 // unchanged
  "meta": { ... }                    // unchanged: title/intro/notes/buildOrder/checks
}
```

### Components

`pins` is an array of pin objects. `loc` is optional and ignored in p2p; order matters,
because it is the physical header order and drawing order:

```jsonc
{ "id": "pn", "label": "PN5180 NFC reader", "short": "PN5180",
  "pins": [{"label":"3V3"}, {"label":"5V"}, {"label":"GND"}, {"label":"RST"}, {"label":"BUSY"}, {"label":"NSS"}, {"label":"MOSI"}, {"label":"MISO"}, {"label":"SCK"}] }
```

New optional fields:

- `short` — compact name used in the connection/pinout tables (`label` stays on the diagram).
- `hub: true` — force this component to be the layout hub (see Layout).

Ignored in p2p mode: `span`, `socket`, top-level `board` and `labels` (all grid concepts).

### Nets

Same objects (`id`, `color`, `label`, `note` unchanged), but endpoints are pins, not holes.
Three accepted forms per endpoint:

| form | example | use |
|---|---|---|
| string | `"pi.P1 3V3"` | native authoring — component id, first `.`, pin name |
| object | `{"comp": "pi", "pin": "P1 3V3"}` | explicit (pin names containing `.`) |
| `[col,row]` | `[2, 2]` | **board-spec reuse** — reverse-resolved through component pin `loc` values |

The `[col,row]` form means an existing perfboard spec whose net endpoints all land on
component pins can flip to p2p by adding one line (`"mode": "point-to-point"`) — no
rewrite. Endpoints that don't resolve to a pin are reported in a warning box and skipped.

`kind` is currently ignored in p2p (everything renders as a wire). Whether inline parts
(a resistor spliced into a wire run) belong in p2p — and if so, whether `kind:"resistor"`
should render the zigzag on the wire — is an open question (see below).

New optional field: `phase` — a free-text group label ("Power & ground", "PN5180 SPI" …).
When it changes from one net to the next it renders as a section header row in the
connection table.

## Build order = spec order

The author's `nets` order **is** the build order — same philosophy as the perfboard
mode's authored `meta.buildOrder`, but now enforced structurally: the table is numbered
1..N and the diagram badges match. Write power/ground nets first, signals after, exactly
as you'd solder. `phase` gives the table section headers; `meta.buildOrder` stays for
prose steps that aren't connections (config.txt edits, installers).

Deliberately **no** automatic reordering heuristic (power-first sniffing by color/name)
— the author already knows the right order and a wrong guess in a wiring guide is worse
than no guess. An opt-in `orderBy` may be added later if authors want it.

## Visual

Hub-and-spoke column layout, all conventions carried over from board mode (dark theme,
purple accents, same palette keys, same `.wire` styling, same hover/click-to-pin
row↔SVG highlight linking, same legend/notes/checks blocks):

1. **Hub** = component with the most connection endpoints (override: `hub: true`).
   For module→Pi builds that's the Pi header, drawn in the left column.
2. **Columns** = BFS depth from the hub (Pi=0, PN5180/NAU7802=1, load cell=2 —
   it only touches the NAU). Disconnected components park in a far-right column.
3. Components are rounded cards with their pins as dots down the edge, in spec order
   (= physical header order). Each pin's dot sits on the edge facing the column its
   wires go to (majority vote when a pin fans out).
4. Within a column, components are ordered by the barycenter of their peers' pin
   positions (cheap crossing reduction), then the column is vertically centered.
5. Wires are cubic béziers, colored by the same palette, each carrying a **numbered
   badge** at its midpoint = its step number in the connection table.

Below the diagram:

- **Legend** (unchanged) + **per-component pinout tables** — for each module, every pin
  and what it goes to (`#6 Pi P23 SCK`), with unconnected pins shown as `—`. This is the
  p2p analogue of board mode's pin→hole tables: it's what you look at while holding the
  module in your hand soldering its side of the harness.
- **Connections — in build order**: the numbered table (swatch, #, From, To, label, notes)
  with `phase` header rows.

## Light DRC (p2p flavor)

Matching the perfboard mode's "cheap subset only" stance:

- **Unresolved endpoints** — net references a component/pin that doesn't exist (typo
  catcher). Warn box + console.warn, net skipped.
- **Stacked joints** — >1 wire landing on one physical pin. Legal, but you want to know
  before you solder (all leads on that pin go in one pass). Warn box.

Full net-tracing DRC stays out of scope, same as board mode.

## Implementation notes

- One file, no build step, same entry point: `renderWiringGuide(spec, el)` dispatches on
  `spec.mode` to `renderPointToPoint` (also exported on `WiringGuide`).
- Shared helpers extracted from the board renderer so both modes stay in lockstep:
  `headerMeta` / `footerMeta` (title/intro/notes, buildOrder/checks) and `linkRow`
  (table-row ↔ SVG highlight).
- The playground (`index.html`) loads point-to-point demo specs (e.g.
  `specs/demo-pin17-vcc-correct.json`); Download-standalone works unchanged since it
  just serializes the spec.

## Open questions

1. **Layout escape hatch** — is heuristic hub/column placement enough, or do we want an
   optional hand-placed `pos: [col, slot]` per component for topologies the heuristic
   mangles (rings, two hubs)?
2. **Inline parts** — do p2p builds ever splice a resistor/diode into a run (e.g. an LED
   + resistor straight off a GPIO)? If yes, honor `kind` in p2p.
3. **Wire-length / harness hints** — worth adding an optional `length` field per net
   ("cut 9 cm") now that there's no grid to infer distance from? Useful for pre-cutting
   the harness in one sitting.
