# Technology Stack

**Analysis Date:** 2026-03-02

## Languages

**Primary:**
- TypeScript (ES2024 target) - monorepo application/runtime code in `packages/*/src/**/*.ts` and `packages/stats/src/client/**/*.tsx` (`tsconfig.base.json`, `tsconfig.json`).

**Secondary:**
- Rust (edition 2024, nightly toolchain) - native addon crate and vendored shell crates in `crates/pi-natives/Cargo.toml`, `crates/brush-core-vendored/Cargo.toml`, `crates/brush-builtins-vendored/Cargo.toml`.
- Python - helper/runtime scripts in `packages/coding-agent/src/stt/transcribe.py` and `packages/ai/scripts/proto-extractor.py`.

## Runtime

**Environment:**
- Bun >= 1.3.7 for all JS/TS packages (`engines.bun` in `packages/coding-agent/package.json`, `packages/ai/package.json`, `packages/tui/package.json`, `packages/utils/package.json`, `packages/agent/package.json`, `packages/natives/package.json`, `packages/stats/package.json`).
- Rust nightly with `rustfmt`, `clippy`, and `rust-analyzer` (`rust-toolchain.toml`).

**Package Manager:**
- Bun workspace at repo root (`package.json` with `workspaces: ["packages/*"]`).
- Lockfile: present (`bun.lock`), plus Cargo lockfile present (`Cargo.lock`).
- npm is used for workspace versioning/publishing workflows (`package.json` scripts `version:*`, `publish`, `publish:dry`).

## Frameworks

**Core:**
- Bun APIs (`Bun.serve`, `bun:sqlite`) power local services and persistence in `packages/stats/src/server.ts`, `packages/stats/src/db.ts`, `packages/coding-agent/src/session/*.ts`, `packages/ai/src/auth-storage.ts`.
- Internal modular packages (`@oh-my-pi/*`) wired through TS path aliases in `tsconfig.base.json` and workspace deps in package manifests.

**Testing:**
- Bun test runner (`bun test`) across all packages via root script `test` in `package.json`.

**Build/Dev:**
- Biome for lint/format (`biome.json`, root scripts `check:ts`, `lint:ts`, `fmt:ts`).
- Type checking via TypeScript native preview (`tsgo`) in root `check:ts` script.
- Cargo for Rust lint/check/format in root scripts `check:rs`, `lint:rs`, `fmt:rs`.
- Bun binary compilation for CLI release artifacts in `packages/coding-agent/package.json` (`build:binary`) and `.github/workflows/ci.yml`.

## Key Dependencies

**Critical:**
- `openai` (`packages/ai/package.json`) - OpenAI + Azure OpenAI integrations in `packages/ai/src/providers/openai-completions.ts`, `packages/ai/src/providers/openai-responses.ts`, `packages/ai/src/providers/azure-openai-responses.ts`.
- `@anthropic-ai/sdk` (`packages/ai/package.json`) - Anthropic provider in `packages/ai/src/providers/anthropic.ts`.
- `@google/genai` (`packages/ai/package.json`) - Gemini/Vertex provider logic in `packages/ai/src/providers/google.ts`, `packages/ai/src/providers/google-vertex.ts`, `packages/ai/src/providers/google-gemini-cli.ts`.
- `@aws-sdk/client-bedrock-runtime` (`packages/ai/package.json`) - Bedrock streaming in `packages/ai/src/providers/amazon-bedrock.ts`.
- `puppeteer` (`packages/coding-agent/package.json`) - browser automation tooling in `packages/coding-agent/src/tools/browser.ts` and `packages/coding-agent/src/tools/puppeteer/*`.

**Infrastructure:**
- `napi`/`napi-derive` in `crates/pi-natives/Cargo.toml` - Node/Bun native addon bridge used by `packages/natives/src/bindings.ts`.
- `winston` + `winston-daily-rotate-file` in `packages/utils/package.json` - centralized logging in `packages/utils/src/logger.ts`.
- `react`/`react-dom`/`chart.js` in `packages/stats/package.json` - local stats dashboard UI in `packages/stats/src/client/*`.

## Configuration

**Environment:**
- Env resolution is centralized in `packages/utils/src/env.ts` (loads from project `.env`, `~/.env`, `~/.omp/.env`, `~/.omp/agent/.env`; process env has highest precedence).
- Provider/auth env surface is documented in `docs/environment-variables.md` and consumed in `packages/ai/src/stream.ts` and `packages/coding-agent/src/cli/args.ts`.

**Build:**
- TypeScript configs: `tsconfig.base.json`, `tsconfig.json`, plus per-package tsconfig files (`packages/*/tsconfig*.json`).
- Lint/format config: `biome.json`, `rustfmt.toml`.
- Rust workspace/build config: `Cargo.toml`, `rust-toolchain.toml`.
- CI/release pipeline: `.github/workflows/ci.yml`.

## Platform Requirements

**Development:**
- Bun 1.3.7+ and Rust nightly toolchain with clippy/rustfmt (`rust-toolchain.toml`).
- System packages for native builds/tests are installed in CI (`.github/workflows/ci.yml`, jobs `check_test`, `install_test`).

**Production:**
- Distributed as npm workspace packages (`package.json` `publish` scripts) and precompiled CLI binaries for macOS/Linux/Windows from CI release job in `.github/workflows/ci.yml`.
- Runtime data is local-first under `~/.omp` (path helpers in `packages/utils/src/dirs.ts`).

---

*Stack analysis: 2026-03-02*