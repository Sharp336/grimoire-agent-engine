Generates a video from a text prompt, from a still image, or by continuing or restyling an existing clip.

<instructions>
- Describe motion, not a scene: subject, action, camera move, lighting, style. A still-life prompt buys a still-looking clip.
- Choose the input by what you want held fixed:
  - nothing — text-to-video, the model frames the shot.
  - `image` — that picture IS frame one.
  - `reference_images` — those subjects/outfits/products appear, framing stays free. Mutually exclusive with `image`.
  - `video` + `mode: "extend"` — new footage continues from its last frame and is appended to it, so the result is longer than the source. `duration` sizes the appended segment only, 2-10s.
  - `video` + `mode: "edit"` — the same footage restyled; duration, ratio and resolution are inherited, not chosen.
- Billed per second of output: iterate at short `duration` and `480p`, then re-run the winning prompt at the size you want.
- Chaining shots: pass `store: "<name>.mp4"`, then feed the reported `file_...` id back as `video`. Paths and data URLs re-upload the whole clip on every call; a stored id does not, and it sidesteps the 32MB inline limit.
- Provider is a capability choice, not a preference. `extend`, `edit`, `reference_images`, `store` and `file_...` inputs exist only on xAI. Reach for `provider: "openrouter"` (or a `vendor/model` id) for Veo, Seedance, Kling and Hailuo, or for 1080p straight from a text prompt — on xAI, 1080p is image-to-video only via `grok-imagine-video-1.5`, which in turn cannot take `reference_images`.
- The call blocks for minutes and writes the finished `.mp4` to `output_path`. Cancelling stops the waiting, never the billing, so settle the parameters before submitting rather than after.
</instructions>
