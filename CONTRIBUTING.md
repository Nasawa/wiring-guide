# Contributing to wiring-guide

Thanks for looking. This library has strong opinions; PRs that fit them merge
fast, PRs that fight them won't.

## The rules of the house

1. **Zero build step.** `wiring.js` is the whole library — a single vanilla-JS
   file you `<script src>` or `require()`. No bundler, no transpiler, no npm
   `dependencies`, ever. Tooling that requires a build to *use* the library
   will be rejected; tooling that requires a build to *develop* it is almost
   certainly also unwelcome.
2. **Self-contained output.** A rendered guide (and the playground's
   standalone-HTML export) must work as one portable file with no network
   fetches.
3. **Board geometry comes from presets.** Hand-coded hole coordinates for a
   known board type are a bug. If a board isn't covered, add a preset (a pure
   `(opts) => {cols, rows, rails, segments}` builder) with the geometry sourced
   from the physical board or its datasheet — and say which in the PR.
4. **Renderer first.** The spec is declarative; smarts live in the renderer.
   Don't add spec fields that encode presentation the renderer could derive.
5. **The DRC stays light.** The duplicate-hole check is deliberately the cheap
   subset. Full net-tracing DRC is out of scope — don't start it in a PR.

## Dev setup

There isn't one. Clone, then:

```
python3 -m http.server 8801     # playground at http://localhost:8801/
node test/run-validation.js     # tests (plain node, zero deps)
```

The playground must be served over HTTP — it `fetch()`es the spec and the
library, which `file://` blocks.

## Before you open a PR

- `node test/run-validation.js` exits 0. CI runs the same command on every PR.
- If you touched the renderer, load the playground and eyeball at least the
  divider demo (it exercises rails, field runs, resistor/diode/jumper net kinds,
  sockets, and a multi-board layout).
- New presets or spec fields: document them in `README.md` and `docs/spec.md`,
  and extend the test harness (geometry counts for presets; a lint/smoke case
  for spec fields).
- New example specs go in `specs/` and must lint clean — the harness picks up
  every `specs/*.json` automatically.
- Keep PRs small and single-concern. Explain *why*, not just what.

## Reporting bugs

An issue with a minimal spec JSON that reproduces the problem is worth ten
paragraphs. Paste the spec, say what rendered, say what you expected.

## License

MIT — by contributing you agree your contributions are licensed under the
project's [LICENSE](LICENSE).
