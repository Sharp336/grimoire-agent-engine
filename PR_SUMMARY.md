# PR Summary: Reasoning Content Preservation for Cross-Model Conversations
Closes #1995


## Overview
This PR implements proper reasoning content preservation for reasoning models (MiniMax M3, DeepSeek V4, GLM-5.1, etc.) during cross-model switches. Previously, thinking blocks were converted to plain text when switching models, losing valuable reasoning context. Now, reasoning content is preserved in its native format for all reasoning-capable models.

## Key Changes

### 1. Thinking Block Preservation Logic (`transform-messages.ts`)
- **Added** `isOfficialApi()` helper to detect official Anthropic/OpenAI endpoints
- **Implemented** 6-step priority chain for thinking block handling:
  1. Same model → preserve with signatures (replay mode)
  2. Official APIs (api.anthropic.com, api.openai.com) → convert to text (preserve old behavior)
  3. `legacy_style: true` → convert to text (safety valve)
  4. `interleaved: false` on reasoning model → convert to text (opt-out)
  5. `anthropic-messages` API → preserve (native support)
  6. `model.reasoning === true` → preserve (new default for all reasoning models)
  7. Non-reasoning models → convert to text

### 2. MiniMax `reasoning_details` Array Format Support
- **Extended** `reasoningContentField` type to include `"reasoning_details"`
- **Implemented** array format construction in `convertMessages`:
  ```typescript
  [{
    type: "reasoning.text",
    id: "reasoning-text-N",
    format: "MiniMax-response-v1",
    index: N,
    text: "..."
  }]
  ```
- **Updated** all MiniMax model configs to use `reasoningContentField: "reasoning_details"`
- **Fixed** reasoning extraction to handle `reasoning_details[].text` array from streaming responses

### 3. Type System Updates (`types.ts`)
- **Added** `interleaved?: boolean` to `OpenAICompat` interface
- **Added** `legacy_style?: boolean` to `OpenAICompat` interface
- **Extended** `reasoningContentField` union: `"reasoning_content" | "reasoning" | "reasoning_text" | "reasoning_details"`

### 4. Schema Validation (`models-config-schema.ts`)
- **Added** `"reasoning_details"` to Zod enum for `reasoningContentField`

### 5. Compatibility Layer (`openai-completions-compat.ts`)
- **Set** `interleaved: true` and `legacy_style: false` as defaults in `detectOpenAICompat`
- **Added** passthrough for `interleaved` and `legacy_style` in `resolveOpenAICompat`

### 6. Model Configuration Updates
- **Updated** `model-thinking.ts`: MiniMax auto-detection → `"reasoning_details"`
- **Updated** `provider-models/openai-compat.ts`: MiniMax Coding Plan descriptors → `"reasoning_details"`
- **Regenerated** `models.json`: All MiniMax entries now use `"reasoning_details"`

### 7. Bug Fixes
- **Fixed** brace corruption in `openai-completions.ts` (missing closing brace for `requiresReasoningContentForToolCalls` block)
- **Fixed** YAML parsing errors in `models.yml` (tab characters instead of spaces)
- **Added** `"reasoning_details"` to all three `recognizedFields` arrays for cross-model compatibility

### 8. Testing
- **Created** `openai-completions-wire-format.test.ts` (6 tests):
  - Validates `reasoning_details` array format construction
  - Validates `reasoning_content` string format
  - Tests empty thinking block filtering
  - Tests synthetic placeholder skipping
  - Tests `onConverted` callback for validation
- **Updated** `transform-messages-thinking-preservation.test.ts` (28 tests):
  - Fixed type errors (`Usage.cost`, `toolName` → `name`)
  - Updated expectations for new priority chain
- **Updated** `openai-completions-compat.test.ts`:
  - Updated expectations for field mapping behavior
  - Added `interleaved`/`legacy_style` to test fixtures

### 9. Cleanup
- **Removed** obsolete `omp-provider-fixes` extension (directory + `enabled.txt` entry)

## Test Results
✅ **82 tests passing** across 3 test files
✅ **TypeScript compiles clean** (zero errors)
✅ **Wire format validated** for both `reasoning_details` (array) and `reasoning_content` (string)

## Backwards Compatibility
- Official APIs (api.anthropic.com, api.openai.com) preserve old behavior automatically
- `legacy_style: true` provides safety valve for providers needing old behavior
- `interleaved: false` allows opt-out for models that don't need reasoning sent back
- Existing configs without new fields work unchanged

## Known Limitations
**DeepSeek API**: DeepSeek's API explicitly ignores `reasoning_content` from prior turns when there are no tool calls (documented behavior). This is a DeepSeek API limitation, not an OMP bug. MiniMax and other models correctly preserve reasoning across all turns.

## Files Modified
- `packages/ai/src/model-thinking.ts` (2 lines)
- `packages/ai/src/models.json` (regenerated, ~19k lines)
- `packages/ai/src/provider-models/openai-compat.ts` (4 lines)
- `packages/ai/src/providers/openai-completions-compat.ts` (6 lines)
- `packages/ai/src/providers/openai-completions.ts` (133 lines)
- `packages/ai/src/providers/transform-messages.ts` (58 lines)
- `packages/ai/src/types.ts` (30 lines)
- `packages/coding-agent/src/config/models-config-schema.ts` (2 lines)
- `packages/ai/test/transform-messages-thinking-preservation.test.ts` (249 lines)
- `packages/ai/test/openai-completions-compat.test.ts` (6 lines)
- `packages/ai/test/openai-completions-wire-format.test.ts` (new file, 6 tests)

## Migration Guide
No migration needed. Existing configurations work unchanged. To use new features:

```yaml
# Enable reasoning preservation for custom models
compat:
  reasoningContentField: "reasoning_details"  # For MiniMax-style array format
  interleaved: true                            # Default for reasoning models
  legacy_style: false                          # Set true for old behavior
```

## Future Work
- Monitor DeepSeek API updates for potential reasoning_content support in non-tool-call turns
- Consider adding request validation hooks for debugging wire format issues
- Expand test coverage for additional reasoning model providers
