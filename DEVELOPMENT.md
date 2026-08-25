# Development Setup

The repository contains the application source and tests. Personal runtime state stays local:

- Copy `.env.example` to `.env` and add credentials only on your machine.
- Create `config.json` through the application or copy `config.example.json` as a starting point.
- `data/` contains the local SQLite database, system inventory, turn traces, and cached feeds.
- `sandbox/` contains local task files and generated media.

These runtime paths are intentionally ignored by Git. Do not commit API keys, session data, databases, desktop inventories, or generated media.

Install dependencies with `npm install`, then run the focused checks:

```sh
node src/test-voice-state.js
node src/test-voice-continuous.js
node src/test-section-gate.js
node src/test-tool-router.js
```

For team work, branch from `main`, keep commits focused, and open a pull request against the shared repository or fork.
