# Tessel

Tessel is a desktop 3D editor for polygon modeling, built with [Tauri](https://tauri.app), TypeScript and
[three.js](https://threejs.org). It ships with an embedded [MCP](https://modelcontextprotocol.io) server, so AI agents
such as Claude can drive the editor while you watch every change happen live.

## Features

- **Polygon modeling**: primitives, text and tubes; extrude, inset, bevel, loop cut, subdivide, merge, fill, booleans,
  mirror; vertex, edge and face selection with loops, rings and grow/shrink; non-destructive modifiers
- **UV editing**: unwrap, pack, transform
- **Materials**: PBR materials, importable from other projects
- **Texture painting**: paint layers with blending, fill, merge and flatten; normal map from height
- **Baking**: normal and ambient occlusion maps
- **Animation and video**: keyframes, motion presets, path following, camera orbits, a timeline with playback, and
  video export (MP4/WebM)
- **Path-traced rendering** for presentation-quality images
- **Import and export**: glTF/GLB, OBJ, STL, PLY, FBX (import), USDZ (export), and native `.tessel` projects
- **MCP server for AI agents**: 150+ tools covering every editor action, batch execution from JSON files, off-screen
  screenshots, and per-document targeting, so an agent can work in a background tab

## Install

Download the installer for your system from the
[latest release](https://github.com/slne-development/tassel/releases/latest):

| System  | File                                                     |
| ------- | -------------------------------------------------------- |
| Windows | `Tessel_<version>_x64_en-US.msi` or `Tessel_<version>_x64-setup.exe` |
| macOS   | `Tessel_<version>_universal.dmg` (Apple Silicon and Intel) |
| Linux   | `.AppImage`, `.deb` or `.rpm`                            |

The builds are not code-signed:

- **Windows**: SmartScreen may warn about an unknown publisher. Click *More info*, then *Run anyway*.
- **macOS**: Gatekeeper blocks the app on first launch. Right-click Tessel in *Applications*, choose *Open*, and confirm,
  or run `xattr -dr com.apple.quarantine /Applications/Tessel.app`.

## Connect an AI agent

While Tessel is running, its MCP server listens on `http://127.0.0.1:4737/mcp`. Every request needs the bearer token
that Tessel generates on first start. Click the MCP indicator in the status bar to copy a ready-made command, for example:

```bash
claude mcp add --transport http tessel http://127.0.0.1:4737/mcp --header "Authorization: Bearer <token>"
```

## Build from source

Requirements:

- [Node.js](https://nodejs.org) 24 and npm
- [Rust](https://rustup.rs) (stable, 1.90 or newer)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system (WebView2 on Windows, Xcode Command
  Line Tools on macOS, WebKitGTK on Linux)

```bash
git clone https://github.com/slne-development/tassel.git
cd tassel
npm ci
npm run app          # run the editor in development mode
npm run tauri build  # build installers into src-tauri/target/release/bundle
```

Checks that CI runs on every pull request:

```bash
npm run typecheck
npm test
cd src-tauri && cargo test
```

## Releasing

The version lives in `package.json` (`src-tauri/tauri.conf.json` reads it from there) and in `src-tauri/Cargo.toml`.
CI fails when the two differ.

To release:

1. Bump `version` in both `package.json` and `src-tauri/Cargo.toml` (and run `cargo check` to update `Cargo.lock`).
2. Merge the change into `master`.

The [Release workflow](.github/workflows/release.yml) sees that the tag `v<version>` does not exist yet, builds the
installers for Windows, macOS and Linux, and publishes them as a GitHub Release with generated release notes. Pushes
that do not change the version do not create a release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
