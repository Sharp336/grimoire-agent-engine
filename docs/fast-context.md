# FastContext

FastContext is an opt-in local model adapter that accelerates codebase exploration. It runs a small local model (FastContext-1.0-4B) to expand natural-language queries into search plans, then executes them with native ripgrep/glob — returning a compact ranked file list and optional snippets in ~2.5s instead of 10–30s.

## What it does

When enabled, the bundled `explore` subagent calls `fast_context` **first** for broad repository-retrieval queries. Without FastContext, explore uses multiple `search`/`find`/`read` tool calls (10K–180K tokens per exploration). FastContext compresses this into a single ~70-token packet — **~95% token savings**.

If FastContext returns no results, the explore subagent automatically falls back to normal search/find/read.

## Setup guide

This guide is written so that an omp agent can follow it step-by-step to set up FastContext for a user.

### Step 1: Install llama.cpp

llama.cpp provides the `llama-server` executable that serves an OpenAI-compatible API locally.

**Windows (prebuilt):**
1. Download the latest `llama-*-bin-win-cuda-cu*.*.zip` from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) (pick the CUDA build if you have an NVIDIA GPU, otherwise the CPU build).
2. Extract to a permanent location, e.g. `C:\llama\llama.cpp\`.
3. Verify: `C:\llama\llama.cpp\llama-server.exe --version`

**macOS:**
```bash
brew install llama.cpp
```
The binary will be at `$(brew --prefix)/bin/llama-server`.

**Linux:** Build from source — see [llama.cpp build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).

### Step 2: Download a FastContext model

Download a FastContext-1.0-4B GGUF model. Two variants are available:

| Model | File | Hit rate | Recommendation |
|---|---|---|---|
| **FastContext-1.0-4B-RL** | `fastcontext-1.0-4b-rl-q4_k_m.gguf` | 100% (2/2 runs) | ✅ **Use this one** |
| FastContext-1.0-4B-SFT | `fastcontext-1.0-4b-sft-q4_k_m.gguf` | 93.75% avg (missed cases) | Not recommended |

The RL model is fine-tuned with a retrieval reward signal — it learns which search plans actually find the right file, not just which plans look plausible. In benchmarks, the RL model hit 8/8 cases in every run, while the SFT model occasionally missed cases by surfacing plausible-sounding but wrong files (e.g. `model-roles.ts` instead of `model-resolver.ts`). Token cost is identical (~95% savings either way); the difference is purely in retrieval accuracy.

Both are ~2.5GB (Q4_K_M quantization, 4B parameters). Place the `.gguf` file in a models directory, e.g. `C:\llama\models\`.

### Step 3: Start the server

#### Quick start (CPU)

```bash
llama-server --model fastcontext-1.0-4b-rl-q4_k_m.gguf --port 8080 --ctx-size 4096
```

#### GPU-accelerated (recommended for NVIDIA GPUs)

For a 16GB VRAM GPU, use a large context with quantized KV cache for whole-repo FastContext queries:

```bash
llama-server \
  --model fastcontext-1.0-4b-rl-q4_k_m.gguf \
  --dev CUDA0 \
  --ngl auto \
  --c 200000 \
  --ctk q8_0 \
  --ctv q8_0 \
  --fa on \
  --np 1 \
  -n 512 \
  --fitt 6144 \
  --host 127.0.0.1 \
  --port 8080
```

Key flags:
- `--dev CUDA0` — use the first NVIDIA GPU
- `--ngl auto` — offload all layers to GPU
- `-c 200000` — 200K-token context window (fits large workspace listings)
- `--ctk q8_0 --ctv q8_0` — quantize KV cache to Q8 (halves VRAM usage with negligible quality loss)
- `--fa on` — enable flash attention for faster inference
- `--np 1` — single slot (full 200K context available per request)
- `-n 512` — cap output at 512 tokens per request (FastContext plans are ~30–80 tokens)
- `--fitt 6144` — fit the model's prompt template into the context

#### Windows batch script

Create `C:\llama\server-fastcontext-gpu.bat`:

```bat
@echo off
setlocal
set "ROOT=%~dp0"
set "MODEL=%ROOT%models\fastcontext-1.0-4b-rl-q4_k_m.gguf"

if not exist "%MODEL%" (
  echo Model not found: "%MODEL%"
  exit /b 1
)

"%ROOT%llama.cpp\llama-server.exe" -m "%MODEL%" -dev CUDA0 -ngl auto -c 200000 -ctk q8_0 -ctv q8_0 -fa on -np 1 -n 512 -fitt 6144 --host 127.0.0.1 --port 8080 %*
```

Then start the server:
```cmd
C:\llama\server-fastcontext-gpu.bat
```

#### Verify the server is running

```bash
curl http://127.0.0.1:8080/v1/models
```

Should return JSON with the model id. Also check health:
```bash
curl http://127.0.0.1:8080/health
```

Should return `{"status":"ok"}`.

### Step 4: Enable FastContext in omp

```bash
omp config set fastContext.enabled true
```

Or interactively: `/settings` → **Context** tab → **Fast Context** group → toggle **Enable FastContext**.

If you are logged in to **Devin**, you can skip the server and model setup entirely — FastContext automatically uses `devin/swe-1-6-fast` (no local llama.cpp server needed). Otherwise, continue with the local server setup below, or pick a provider model from the **FastContext Model** dropdown in `/settings`.

### Step 5: Verify it works

Start an omp session and ask the explore subagent to find something:
```
explore "Find where the FastContext adapter tool class is defined"
```

If FastContext is working, the explore subagent will call `fast_context` first and return results in ~2–3s. If it fails or returns nothing, the subagent falls back to normal search automatically.

## Settings

All settings appear in `/settings` under **Context → Fast Context**. The `model` and `baseUrl` fields are hidden until `enabled` is toggled on.

| Setting | Default | Description |
|---|---|---|
| `fastContext.enabled` | `false` | Toggle the FastContext adapter on/off. |
| `fastContext.model` | *(auto)* | Model for query expansion. Pick a provider model (e.g. `devin/swe-1-6-fast`, `zai/glm-5-turbo`) to route through your provider credentials — no local server needed — or **Local llama.cpp server**. When unset and Devin is logged in, `devin/swe-1-6-fast` is used automatically (a `local` sentinel or bare id forces the local server). |
| `fastContext.mode` | `hint` | Retrieval mode: **Hint** (default — one turn → native search, ~2-3s) or **Agent** (full multi-turn Read/Glob/Grep loop, slower and more thorough). Set in `/settings` → Context → Fast Context. |
| `fastContext.baseUrl` | `http://127.0.0.1:8080` | Base URL for the local OpenAI-compatible chat completions endpoint. Only shown when the model is set to the local server. |

### YAML config

```yaml
fastContext:
  enabled: true
  model: ""  # auto: devin/swe-1-6-fast if Devin is logged in, else local server
  mode: hint  # hint (fast, default) or agent (full multi-turn loop)
  baseUrl: http://127.0.0.1:8080  # only used by the local server backend
```

### Using LM Studio or Ollama instead of llama.cpp

Any OpenAI-compatible local endpoint works — just point `baseUrl` at the port:

```bash
omp config set fastContext.baseUrl http://127.0.0.1:1234  # LM Studio
omp config set fastContext.baseUrl http://127.0.0.1:11434  # Ollama
```

### Using a cloud provider model instead of a local server

If you don't want to run a local model, point FastContext at any registered provider model by setting `fastContext.model` to a provider-prefixed id. FastContext resolves it through the model registry using your configured credentials and calls it directly — no llama.cpp/LM Studio/Ollama required.

```bash
omp config set fastContext.enabled true
omp config set fastContext.model devin/swe-1-6-fast   # Devin SWE-1.6 fast tier (login: /login devin) — 100% retrieval @ ~1.6s hint / ~3.3s agent, no local GPU
# other devin tiers: devin/swe-1-6 (standard), devin/swe-1-6-slow (reasoning-heavy, ~34s hint)
# or any provider model: zai/glm-5-turbo, openai-codex/gpt-5.5, pi/smol, ...

A provider-prefixed value (containing `/`) always selects the registry path; a bare id or blank keeps the local-endpoint behavior above. Both hint and agent modes are supported. Agent mode reuses one cascade id across all turns so the provider can thread the conversation. The `devin/swe-1-6-fast` tier (Cerebras 950 tok/s, same intelligence as `swe-1-6`) is the fastest option — faster than even a local 4B model — while `swe-1-6-slow` is reasoning-heavy and much slower per turn.

## How it works

### Hint mode (default, ~2.5s)

1. The explore subagent calls `fast_context` with a natural-language query.
2. FastContext sends the query to the local model, which returns a plan: keywords, glob patterns, grep patterns, and search paths.
3. Native ripgrep and glob execute the plan in parallel — no model inference during search.
4. Results are ranked by path-keyword matches, content-keyword density, and grep/glob match signals.
5. A compact packet (`[FC hint: N files]` + file list + optional snippets) is returned.

If the model returns an empty plan, a query-derived fallback extracts keywords from the query itself and runs the same grep/glob/ranking pipeline.

### Agent mode (~25–45s)

Agent mode runs a full multi-turn agentic loop where the model calls `Read`, `Glob`, and `Grep` tools directly. Slower but the model can read file contents and refine searches. Hint mode is recommended for interactive use.

## Performance

Measured on the oh-my-pi repo (8 cross-package queries, FastContext-1.0-4B-RL-Q4_K_M, NVIDIA GPU):

| Metric | Without FastContext | With FastContext (hint) |
|---|---|---|
| Hit rate | — | 95–100% |
| Latency | 10–30s (multiple tool calls) | ~2.5s (single LLM turn + native search) |
| Token cost | 10K–180K per exploration | ~70 tokens per packet |
| Token savings | — | ~95% aggregate |

## Troubleshooting

- **"FastContext hint failed: HTTP connection refused"** — The llama.cpp server isn't running. Start it with the batch script or command from Step 3.
- **No results / empty hint** — The model may return an empty plan. FastContext automatically falls back to query-derived grep. Check that the model is loaded (`curl http://127.0.0.1:8080/v1/models`).
- **Slow responses** — Without GPU offload (`--ngl`), the 4B model takes ~4–6s per turn on CPU. With GPU, it's ~1.5s. Ensure `-ngl auto` is set for GPU offload.
- **Out of memory (OOM)** — Reduce context size (`-c 8192` instead of `-c 200000`) or remove KV cache quantization (`-ctk q8_0 -ctv q8_0`). The 200K context requires ~16GB VRAM with Q8 KV cache.
- **Wrong files returned** — FastContext returns up to 20 candidate files. The ranking pipeline prioritizes files with query keywords in their path or content. Grep-matched files are boosted above glob-matched files.
