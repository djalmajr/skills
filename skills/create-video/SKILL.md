---
name: create-video
description: "Create a video: live UI screencast (Playwright) or composed motion (Remotion). Use when the user asks to record a screencast, video-aula, promo, intro, motion graphics, Remotion composition, Playwright recordVideo, or runs /create-video. Types: --type=screencast|motion|promo|intro. Spoken audio from /create-audio."
---

# Create video

Pick the **type** first. That picks the engine.

Spoken audio comes from **`/create-audio`**. If `default-vo/` is missing, invoke that skill first (it will ask *how* to make the voice).

Initial context via slash: `$ARGUMENTS`

Parse `--type=` from `$ARGUMENTS` when present.

## Project root

- Screencast: `<project-root>/tmp/screencast/<module>/`
- Remotion types: `<project-root>/tmp/video/<module>/`
- Do not commit large webm/MP4 or passwords. Credentials via env only.

## Prompting

Ask **type** unless `$ARGUMENTS` already has `--type=`.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Type | Changes engine | `screencast` (real UI, Playwright) · `motion` (Remotion graphics) · `promo` (Remotion) · `intro` (Remotion titles / sting) |
| Work mode (`screencast`) | Branches the session | Full record+mux · Record only · Mux only · Review existing cut |
| Take shape (`screencast`) | Changes recorder | Continuous take (recommended) · Per-beat clips |
| BGM | Changes mix | Soft bed + duck · No BGM |
| Audio source | When `default-vo/` is missing | Invoke `/create-audio` now · User-supplied WAVs |
| Hybrid | When both are needed | Screencast first, then Remotion wraps the MP4 |

Free-form: project root, `BASE_URL`, beat table, sign-in env **names** only, Remotion composition id.

No-pause (also for delegated runs with nobody to ask): if the ask is “record the app”, `--type=screencast`. If it is “intro / promo / motion”, Remotion. Do not invent a Remotion app when a screencast was requested.

## When to use

- Product tutorial, onboarding, changelog walkthrough → `screencast`
- Title card, sting, motion graphics, designed promo → Remotion types
- Screencast **plus** titles → hybrid (see [references/remotion.md](references/remotion.md))

## When not to use

- Audio-only lesson or podcast — `/create-audio`
- Fake product UI (image model or Ken Burns stills) as the lesson body

## Types

| `--type` | Engine | Use |
|---|---|---|
| `screencast` | Playwright `recordVideo` + ffmpeg mux | Teach a real UI. Narration is the script; the screen is the proof. |
| `motion` | [Remotion](https://www.remotion.dev/) | Composed motion graphics |
| `promo` | Remotion | Designed recap / ad that is not a click-by-click lesson |
| `intro` | Remotion | Open / close / sting |

Remotion procedure: [references/remotion.md](references/remotion.md). Do not vendor a Remotion app in this skill — scaffold when that type is chosen (`npx create-video@latest`).

## Hard rules (`screencast`)

1. **Real UI.** Stills + Ken Burns / zoom-pan do not teach a product.
2. **One beat = one screen.**
3. **Narrative order ≠ file id.**
4. **Cursor only moves to act.** Large overlay. Native hover/focus only.
5. **Never speed up the video** (`setpts < 1`). Freeze the last frame if picture is short. Chrome WebM often lacks a duration index — remux before muxing (the assemble template does this).
6. **Continuous take** when there is BGM.
7. **Do not click what the VO does not name.**
8. **Seed visible data. Sign in off-camera.**

Voice engines and clone method live in `/create-audio`. Do not re-open a TTS A/B here.

Details: [references/gotchas.md](references/gotchas.md), [references/recording.md](references/recording.md), [references/assembly.md](references/assembly.md).

## Process (`--type=motion` / `promo` / `intro`)

Follow [references/remotion.md](references/remotion.md). Scaffold Remotion in `tmp/video/<module>/`, import `/create-audio` (and optional screencast footage), render an MP4. Do not replace a product lesson with designed stills.

## Process (`--type=screencast`)

### 1. Beats

| Order | id | VO (summary) | Route the whole beat | Allowed actions |
|---|---|---|---|---|
| 1 | 01-… | … | `/…` | none or 0–2 |

`wav` names must match `default-vo/` from `/create-audio`. See [templates/beats.json](templates/beats.json).

### 2. Audio

If `default-vo/` is empty: `/create-audio --type=tutorial` (or `voiceover`). Then continue.

### 3. Record

Copy [templates/record.mjs](templates/record.mjs).

```bash
BASE_URL=http://localhost:PORT node record.mjs
PLAYWRIGHT_CHANNEL=chrome node record.mjs
```

One `continuous.webm`. Hold ≈ VO + breath + ~0.9 s.

### 4. Assemble

Copy [templates/assemble.mjs](templates/assemble.mjs).

```bash
node assemble.mjs
NO_BGM=1 node assemble.mjs
BGM_VOLUME=0.22 node assemble.mjs
```

Bed **0.22**, duck ratio ~4. H.264 + AAC, 48 kHz, 1440×900.

### 5. Review

Does the VO describe the screen every second? Reject per [references/gotchas.md](references/gotchas.md).

## Verification

```bash
node skills/create-video/scripts/smoke.mjs
PLAYWRIGHT_REQUIRE=/path/to/app/package.json node skills/create-video/scripts/smoke.mjs
```

## Chain

`/create-audio --type=tutorial` → `/create-video --type=screencast`.  
Optional wrap: `/create-video --type=intro` or `--type=promo` (Remotion) using that MP4 as footage.
