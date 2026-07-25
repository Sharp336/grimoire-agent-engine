Generates a video from a text prompt, optionally animating a still image.

<instructions>
- Describe motion, not just a scene: subject, action, camera move, lighting, style.
- Set `image` (path or https URL) to animate a still; `prompt` then describes how it should move.
- Generation is asynchronous and takes minutes. The tool submits, polls, and writes the finished `.mp4` to `output_path`.
- Billed per second of output. Keep `duration` short and `resolution` low while iterating on a prompt.
- `1080p` requires xAI `grok-imagine-video-1.5`, which is image-to-video only.
</instructions>
