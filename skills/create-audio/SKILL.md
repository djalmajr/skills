---
name: create-audio
description: "Create spoken audio (podcast, tutorial, voiceover) with a locked voice. Ask how to generate it: local VoxCPM2 or CosyVoice3 (clone an approved ref), Grok/xAI Voice, OpenAI TTS, or a timing placeholder. Use when the user asks to generate audio, narration, podcast, audio lesson, VO, TTS, voice clone (also PT: narração, aula em áudio, clone de voz), or runs /create-audio. Types: --type=podcast|tutorial|voiceover. Sibling of /create-video."
---

# Create audio

Produce a **same-person** spoken track from a script. Output is WAV/MP3. Picture is `/create-video`.

Initial context via slash: `$ARGUMENTS`

Parse `--type=` from `$ARGUMENTS` when present.

## Project root

`<project-root>/tmp/audio/<module>/`. Do not commit large WAV/MP3 or API keys. Commit `lines.json` + `DEFAULT.md`.

## Prompting

Ask these **before generating**, unless `$ARGUMENTS` already answers them.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Type | Changes line length and deliverable | `tutorial` (short lines for a later video) · `podcast` (longer takes, one episode file) · `voiceover` (same as tutorial, named for mux) |
| How to create the voice | Changes stack, license, and cost | **VoxCPM2** (local clone of an approved ref) · **CosyVoice3** (local clone) · **Grok / xAI Voice** · **OpenAI TTS** · Other hosted · macOS `say` (timing only) |
| Identity | When local clone / design | Existing approved `ref.wav` · New CustomVoice take · Hunt with VoiceDesign then lock |

Free-form: language, tone, script, proof sentence, module name.

No-pause defaults (also for delegated runs with nobody to ask): `--type=tutorial`, **ask is skipped only if the user already named an engine**; otherwise do not invent a hosted key or start a multi-GB download.

## When to use

- Voiceover lines for `/create-video --type=screencast`
- Audio-only lesson
- Podcast / spoken newsletter
- Voice A/B for a brand

## When not to use

- Recording a screen — `/create-video`
- Voice-in-product (user talks to the app)

## Hard rules

1. **Ask how the audio will be created.** Do not silently pick an engine.
2. **One identity** for the whole set. Rank one locked speaker × one proof sentence. Never rank VoiceDesign folders of independent takes.
3. **Approve the reference first** when cloning. A thin/nasal/"duck" take is almost always a **bad ref**, not a bad engine — the clone copies whatever you feed it.
4. **If the ref changes, regenerate every line.**
5. **License before you like the take.** Local defaults (Qwen3-TTS, VoxCPM2) are Apache-2.0. Skip research/non-commercial weights for anything that might ship. Hosted voices follow that vendor's ToS.
6. **macOS `say` times a line.** It is not a product voice.

Details: [references/engines.md](references/engines.md), [references/gotchas.md](references/gotchas.md).

## Types

| `--type` | Script | Deliverable |
|---|---|---|
| `tutorial` / `voiceover` | Short lines, one idea each | `default-vo/<id>.wav` (+ optional concat) |
| `podcast` | Longer paragraphs, conversation allowed | `episode.wav` / `episode.mp3` via [templates/assemble-audio.mjs](templates/assemble-audio.mjs) |

Same identity rules for every type.

## Process

### 1. Type + engine

Resolve `--type`. Then ask **how** (table above). Record the choice in `DEFAULT.md`.

### 2. Script

Save [templates/lines.json](templates/lines.json). `proofId` is the A/B line.

### 3. Generate

Follow the chosen engine in [references/engines.md](references/engines.md).

**Local (the two engines that won the ear test: VoxCPM2 and CosyVoice3):**

1. Start from an **approved** `ref.wav` (human take, or a Qwen3 CustomVoice take you actually liked — Qwen is a ref source, not the shipped engine).
2. Clone every line with **VoxCPM2** ([templates/generate-vo.py](templates/generate-vo.py)) or **CosyVoice3**.
3. Listen: ref vs clone of the proof line, then the full set.

Do not blame VoxCPM/CosyVoice for a duck/nasal set if the ref already sounds like that.

**Grok / OpenAI / other hosted:** one voice id for the whole set, key only in env, still listen to the proof line before rendering everything.

### 4. Deliver

- Video later: point `/create-video` at `default-vo/`.
- Podcast / aula: `node assemble-audio.mjs` (optional `OUT_FORMAT=mp3`).

## Verification

```bash
node skills/create-audio/scripts/smoke.mjs
```

Then listen. Do not ship on spectrograms.

## Chain

`/create-audio --type=tutorial` → `/create-video --type=screencast`.
