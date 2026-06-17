# OMLX Provider Implementation

## Overview

OMLX is an MLX-based LLM inference server optimized for Apple Silicon (M1/M2/M3/M4). This implementation adds OMLX as a provider in oh-my-pi with automatic model discovery and optional authentication.

## What is OMLX?

OMLX (https://github.com/jundot/omlx) is a high-performance inference server for Apple Silicon that features:

- **Continuous Batching**: Handles concurrent requests efficiently
- **Tiered KV Caching**: Hot (RAM) and cold (SSD) cache tiers for persistent context
- **Multi-Model Serving**: LLMs, VLMs, embeddings, and rerankers
- **OpenAI-Compatible API**: Drop-in replacement for OpenAI `/v1/chat/completions`
- **Native macOS App**: Menu bar control with auto-update
- **Admin Dashboard**: Web UI for model management, monitoring, and chat

## Implementation Details

### Files Created

- `packages/ai/src/registry/omlx.ts` - OAuth provider definition with login flow
- Added OMLX support to existing files:
  - `packages/catalog/src/provider-models/openai-compat.ts` - Model manager options
  - `packages/catalog/src/provider-models/descriptors.ts` - Provider catalog entry
  - `packages/ai/src/registry/registry.ts` - Registry provider list
  - `packages/coding-agent/src/config/model-registry.ts` - Implicit discovery
  - `packages/coding-agent/src/config/model-discovery.ts` - Base URL helper

### Provider Configuration

**Provider ID**: `omlx`

**Default Base URL**: `http://localhost:8000`

**API**: OpenAI-compatible (`openai-responses`)

**Authentication**: Optional (keyless by default, supports `--api-key` flag)

**Discovery**: Automatic via `/v1/models` endpoint

OLMX server is hosted on a different machine in the local network.
http://jupiter.local:2524

The omp client is configured to connect to the OMLX server .


### Use with oh-my-pi

First step is to discover the list of model available on the OMLX server. The discovery is done automatically when the OMLX server is running and omp is launched.

**Launch omp**:
```bash
omp
```


**Login to OMLX** (if authentication required):
```bash
omp /login
# Select "OMLX (MLX Inference Server)"
# Enter API key or leave empty for no-auth mode
```

## Configuration Examples

### Example 1: Local Default Setup
```bash
# OMLX running on localhost:8000, no auth
omlx serve --model-dir ~/models
# oh-my-pi auto-discovers
omp
```

### Example 2: Custom Host and Port (Your Setup)
```bash
# OMLX running on jupiter.local:2524, no auth
export OMLX_BASE_URL="http://jupiter.local:2524"
omp
```

### Example 3: With Authentication
```bash
# OMLX with API key
omlx serve --model-dir ~/models --api-key mysecretkey
export OMLX_API_KEY="mysecretkey"
omp
```

### Example 4: Explicit Configuration in models.yml
```yaml
providers:
  omlx:
    baseUrl: http://jupiter.local:2524/v1
    api: openai-responses
    auth: none  # or "apikey" if using authentication
    # apiKey: "your-key"  # uncomment if using auth
    discovery:
      type: openai-models-list
```

## Model Discovery

OMLX models are automatically discovered via the `/v1/models` endpoint. The implementation:

1. Queries `http://<baseUrl>/v1/models`
2. Maps OpenAI-compatible model records to oh-my-pi model specs
3. Sets context window and max tokens from response
4. Marks models as free (cost: 0) since they're running locally
5. Caches discovered models for fast startup

**Supported Model Types**:
- LLMs (Llama, Qwen, GLM, DeepSeek, etc.)
- VLMs (Vision-Language Models)
- Embeddings (BGE-M3, ModernBERT)
- Rerankers (ModernBERT, XLM-RoBERTa)

## Features

### What Works

✅ Automatic model discovery  
✅ OpenAI-compatible chat completions  
✅ Streaming responses  
✅ Tool calling (for supported models)  
✅ Vision models (multi-image chat)  
✅ Custom base URLs  
✅ Optional authentication  
✅ Implicit discovery (auto-connects when OMLX is running)

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OMLX_BASE_URL` | OMLX server base URL | `http://localhost:8000` |
| `OMLX_API_KEY` | API key for authentication | None (keyless) |

## Differences from Ollama

While OMLX and Ollama are similar (both local inference servers), OMLX:
- **Uses standard OpenAI API**: No native `/api/tags` endpoint
- **Discovery type**: `openai-models-list` instead of `ollama`
- **Default port**: 8000 vs Ollama's 11434
- **Platform**: Apple Silicon only (MLX framework)
- **Features**: Tiered KV caching, admin dashboard, model pinning

## Troubleshooting

### Models Not Appearing

1. **Check OMLX is running**:
   ```bash
   curl http://localhost:8000/v1/models
   ```

2. **Check base URL**:
   ```bash
   echo $OMLX_BASE_URL
   ```

3. **Force refresh**:
   ```bash
   omp /refresh-models
   ```

### Connection Refused

1. **Verify OMLX server is accessible**:
   ```bash
   curl http://jupiter.local:2524/v1/models
   ```

2. **Check firewall settings** (if using custom host)

3. **Ensure base URL includes port** (if non-standard)

### Authentication Errors

1. **If OMLX requires auth, set API key**:
   ```bash
   export OMLX_API_KEY="your-key"
   ```

2. **Or configure in models.yml**:
   ```yaml
   providers:
     omlx:
       apiKey: "your-key"
   ```

## Architecture

```
oh-my-pi
    ├── Model Registry
    │   └── Implicit Discovery
    │       └── OMLX (if running)
    │           └── http://<baseUrl>/v1/models
    │
    └── Provider
        └── OMLX Provider
            ├── Login Flow (optional)
            ├── Model Manager
            └── OpenAI-compatible API
                └── /v1/chat/completions
```

## Testing

To verify the implementation:

```bash
# 1. Start OMLX with models
omlx serve --model-dir ~/models

# 2. Check models are discovered
omp /models | grep omlx

# 3. Test chat
omp --model "omlx/your-model-name"
> Hello, how are you?
```

## References

- [OMLX GitHub](https://github.com/jundot/omlx)
- [OMLX Documentation](https://omlx.ai)
- [MLX Framework](https://github.com/ml-explore/mlx)
- [mlx-lm](https://github.com/ml-explore/mlx-lm)

## Code Quality

- ✅ Zero TypeScript compilation errors
- ✅ Follows Ollama provider pattern
- ✅ Proper type safety throughout
- ✅ Environment variable support
- ✅ Implicit discovery for ease of use
