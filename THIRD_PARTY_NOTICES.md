# Third-party notices

## Excalidraw

`upstream-overlay/excalidraw-app/App.tsx`, `data/LocalData.ts`, and `vite-env.d.ts` contain modified Excalidraw source from the commit pinned in `upstream-lock.json`. The installer also downloads and builds that upstream source. `localAutomation.ts` supplies this project's local automation bridge.

Excalidraw is copyright (c) 2020 Excalidraw and is distributed under the MIT license. The full notice is retained in `licenses/Excalidraw-MIT.txt` and in the downloaded upstream `LICENSE`. Preserve this notice when redistributing a build containing Excalidraw.

Source: https://github.com/excalidraw/excalidraw

## Runtime and dependencies

Node.js is downloaded from https://nodejs.org/ only when needed. Its distribution contains its own license and third-party notices. Node.js is not committed to this repository.

The MCP TypeScript SDK, Zod, smol-toml, Playwright and other dependencies retain their license files in their installed npm packages. This repository pins direct package versions and includes `package-lock.json`; it does not vendor their source. The upstream editor's dependencies are governed by its `yarn.lock` and their respective licenses.
