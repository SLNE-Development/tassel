# Contributing to Tessel

Thanks for helping out! Tessel is a hobby project, so keep changes focused and easy to review.

## Setup

Follow [Build from source](README.md#build-from-source) in the README, then run the app with `npm run app`.

## Project layout

- `src/`: the editor frontend (TypeScript, React, three.js). `src/core` holds the document model and editor commands,
  `src/viewport` the 3D view, `src/ui` the interface.
- `src-tauri/`: the Rust backend, including the embedded MCP server (`src-tauri/src/mcp.rs`, `tools.rs`, `batch.rs`).

## Workflow

1. Create a branch from `master` and open a pull request.
2. Make sure the checks pass locally:
   ```bash
   npm run typecheck
   npm test
   cd src-tauri && cargo test
   ```
3. Add or update tests for behavior you change. Frontend tests live next to the code as `*.test.ts`; Rust tests live
   in `*_tests.rs` files.
4. When CI is green, the pull request goes through the merge queue and is squash-merged into `master`.

Do not bump the version in a regular pull request: a version bump on `master` publishes a release (see
[Releasing](README.md#releasing)).

## Reporting bugs

Open an issue with the bug report template. Include your OS, the Tessel version, and steps to reproduce. For problems
with an AI agent driving Tessel over MCP, include the tool calls involved if you can.
