# Starter templates

Ready-to-use starting specs — copy one and replace the placeholder parts instead
of starting from a blank spec. Each is minimal and validates + renders clean.

| file | board / mode | start here for |
|---|---|---|
| [`perfboard.json`](perfboard.json) | `perf` preset | point-to-point soldering on a generic protoboard |
| [`breadboard-half.json`](breadboard-half.json) | `breadboard-half` preset | solderless prototyping on a 400-pt breadboard |
| [`point-to-point.json`](point-to-point.json) | `point-to-point` mode | module pins wired straight to a controller, no board |
| [`raspberry-pi-pico.json`](raspberry-pi-pico.json) | `point-to-point` + `raspberry-pi-pico` pinout | a Pico build with can't-be-wrong validation on |

Load one in the playground (paste its JSON), or `fetch()` it and pass it to
`renderWiringGuide`. See [`../docs/spec.md`](../docs/spec.md) for the full field
reference and [`../README.md`](../README.md#board-presets) for the board presets.

Built-in pinouts for validation: `raspberry-pi-40`, `raspberry-pi-pico`,
`arduino-uno-r3`, `arduino-nano-v3`, `esp32-devkitc-38pin`,
`esp8266-nodemcu-v1`, `wemos-d1-mini` — and you can define your own board
inline via the spec-level `pinouts` map (see `../docs/spec.md`). More
built-in dev-board pinouts land verified against datasheets, not guessed.
