# agile-tdd · project type: `mobile` (stub)

**Planned**, not yet implemented.

## Detection (planned)

- Expo: `app.json` with an `"expo"` block.
- React Native bare: `ios/Podfile` or `android/build.gradle`.
- Flutter: `pubspec.yaml` with `flutter:` block.

## What it would enforce

After edits touching native or platform-specific code:

1. The relevant platform builds green:
   - `expo prebuild` / `pod install` / `gradlew assembleDebug`
     depending on the layout.
2. At least one simulator/emulator screenshot via the appropriate MCP
   (e.g. `mcp__simulator__screenshot`) recorded after the last edit
   under `ios/**`, `android/**`, or `src/screens/**`.
3. (Optional) `detox` or `maestro` smoke test execution evidence
   (a `*-success.json` artifact in `.maestro/results/`).

## Open questions

- Which MCP servers expose simulator/device control? Expo CLI is well
  documented but headless simulator screenshots vary by platform.
- Per-platform `apps[]` analog: monorepo with `ios/`, `android/`, and a
  shared `src/` — do we treat each platform as an "app root" for the
  per-app evidence rule?

## Why it isn't implemented yet

Awaiting the first agile-tdd adoption in a mobile project. The
template framework is generic — fork `tauri/` as a starting point and
adapt the evidence checks to platform-specific tooling.

Adding it: see [`../README.md → Adding a new type`](../README.md).
