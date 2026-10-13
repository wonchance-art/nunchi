# Held-out benchmark apps

These apps are **held out**. They exist only to check, once, whether nunchi's rules and AI lenses generalise beyond
the app they were developed on (`bench/pebble/`).

- They are not in CI and not part of `npm test`.
- Do not open them, read their source or their answer keys (`bench/answers/<name>.json`), tune lenses or rules
  against them, or change them after measuring. A held-out app that has been looked at is no longer held out.
- Results are recorded only as gate results in `docs/spec-0.1.md` §9 (recall, false positives on clean screens,
  determinism, fingerprint stability), never as per-seed notes that would guide a fix.

Run one (installs its pinned dependencies on first use, builds it, captures it twice and scores it):

```sh
node bench/run.mjs --app bench/heldout/<name> --twice
```

The report goes to `bench/out/<name>/`.

| App | What it is |
|---|---|
| `pegroom` | an invented community tool library with bench booking (React Router, Vite SPA, `server.mjs`) |
