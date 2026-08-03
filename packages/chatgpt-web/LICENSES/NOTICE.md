# Third-party notices

OMP and `@oh-my-pi/pi-chatgpt-web` are distributed under the OMP MIT License in the repository root `LICENSE`:

- Copyright (c) 2025 Mario Zechner
- Copyright (c) 2025-2026 Can Bölük

That OMP notice is separate from the following third-party attribution.

Portions of the browser-turn, Markdown conversion, and full-mode broker behavior were adapted from [OpenCodex](https://github.com/lidge-jun/opencodex) work carried through `codex-chatgpt-web`, under the MIT License. The exact OpenCodex copyright and license text is preserved in [`OpenCodex-MIT.txt`](OpenCodex-MIT.txt).

The provider and launcher runtime third-party dependencies resolved in `bun.lock` are:

| Package | Locked version | License |
| --- | ---: | --- |
| `@modelcontextprotocol/sdk` | 1.26.0 | MIT |
| `fflate` | 0.8.3 | MIT |
| `playwright-core` | 1.62.1 | Apache-2.0 |
| `turndown` | 7.2.4 | MIT |
| `turndown-plugin-gfm` | 1.0.2 | MIT |
| `zod` | 4.4.3 | MIT |
| `motion` | 12.42.2 | MIT |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |
| `electron` | 41.7.1 | MIT |

The workspace dependencies `@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`, and `@oh-my-pi/pi-natives` are OMP components covered by the root OMP license. Transitive JavaScript dependency license texts remain distributed with their installed packages and are collected from the resolved lock graph into packaged runtime notices by the launcher build.

Packaged Electron distributions also retain Electron's generated Chromium and Node third-party license resources.

Full mode interoperates with the official `openai/tunnel-client`, obtained separately for the target platform and accepted only after identity and checksum verification. It is not part of this source package.

The launcher runtime redistributes Bun 1.3.14. Bun's upstream runtime, linked-library, polyfill, and relinking notice is preserved in [`Bun-runtime.md`](Bun-runtime.md) and the build rejects a notice/version mismatch.

ChatGPT and OpenAI are trademarks of OpenAI. Their use is descriptive only. This software is independent and is not affiliated with or endorsed by OpenAI.
