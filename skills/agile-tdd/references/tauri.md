# Tauri MCP validation (project type)

Read when the `tauri` project type is active.

Knowhow consolidated from real Tauri debug/test sessions. Read this
before touching `src-tauri/src/**` or any `src/{routes,components,hooks}/**`
in a Tauri-detected repo.

## Toolbox (canonical references)

- `mcp__tauri__driver_session(start)` — always invoke first; subsequent
  webview tools assume an active session.
- `mcp__tauri__webview_screenshot` — the canonical "I opened the
  screen" signal. Pass `windowId="main"` (Tauri apps usually have
  `main` + `tray-panel`).
- `mcp__tauri__webview_execute_js` — for invokes that take longer than
  the JS executor timeout (≈seconds), fire-and-forget via
  `window.__TAURI_INTERNALS__.invoke(cmd, args).then(r => window.__last = r)`;
  poll DB or screenshot instead of `await`-ing.
- `mcp__tauri__webview_interact` / `webview_find_element` / refs in
  `webview_dom_snapshot` — these depend on `window.__MCP__.resolveRef`
  which is **undefined after dev-server HMR reload**. Prefer
  `document.querySelector(...).click()` via `webview_execute_js`.

## Rebuild flow

- Rust change → `touch src-tauri/src/<file.rs>` forces `tauri-dev` to
  rebuild (cargo's mtime watcher).
- Monitor the dev process output for `Finished` + `MCP Bridge plugin
  initialized` before re-running MCP calls; HMR only covers the
  frontend.
- In Claude Code, prefer `Monitor` with the filter
  `tail -f tauri.log | grep --line-buffered -E "Finished|error\\[|MCP Bridge plugin initialized"`.

## Validation patterns

- **DB direct read** — cheaper than `invoke()` for state assertions:
  `sqlite3 <workspace>/<app>.db "SELECT ..."`.
- **GPU offload check** — `ps -p $(pgrep -x <app-name>) -o pcpu,etime`.
  Apps using Metal/CUDA show low CPU (5-15%) when the GPU is doing the
  work; CPU-only fallback shows 200-400%.
- **Visual check** — `location.assign('/route/...')` via
  `webview_execute_js`, wait ~500ms, then `webview_screenshot`.

## Known gotchas (cross-project patterns)

Each project keeps its own list of in-tree fixes (e.g. in a
`wiki/technical/tauri-gotchas.md` for projects that follow the LLM
wiki pattern). The items below describe the **patterns** — the actual
file paths vary per project.

- **whisper-rs 0.14.x `set_abort_callback_safe` type confusion** — in
  v0.14.4 the trampoline is instantiated with the original closure
  type, while `user_data` is actually written as
  `Box<dyn FnMut() -> bool>`. The callback dereferences the wrong
  memory layout and returns garbage bools, aborting whisper at 0–5%
  with error `-6`. Workaround: use the `unsafe` variant
  `set_abort_callback` + `set_abort_callback_user_data` with a
  hand-written trampoline that matches the stored type:

  ```rust
  unsafe extern "C" fn abort_trampoline(ud: *mut std::ffi::c_void) -> bool {
      let f = &mut *(ud as *mut Box<dyn FnMut() -> bool>);
      f()
  }
  let closure: Box<dyn FnMut() -> bool> = Box::new({
      let cancel = cancel.clone();
      move || cancel.load(Ordering::Relaxed)
  });
  let ud = Box::into_raw(Box::new(closure)) as *mut std::ffi::c_void;
  unsafe {
      params.set_abort_callback(Some(abort_trampoline));
      params.set_abort_callback_user_data(ud);
  }
  ```

- **Background jobs stuck `running` after binary kill** — a tokio task
  that dies mid-flight (cargo restart, app crash) never updates its
  DB row to a terminal state. Add a reconcile pass at pool-open:

  ```rust
  // db::open_pool, after schema migration
  sqlx::query(
      "UPDATE jobs SET status='cancelled',
           error_message=COALESCE(error_message,'interrupted by app restart'),
           finished_at=?
       WHERE status IN ('running','pending')"
  ).bind(now_iso()).execute(&pool).await?;
  ```

- **Modal libraries that couple `open` to data state** (e.g. Base UI
  Dialog, some Radix patterns) — when the data prop goes `null` in
  the same render that `open` flips false, the modal unmounts before
  the close animation finishes; pointer-events stay trapped on
  `document.body` and the page becomes unclickable. Decouple `open`
  (boolean) from the data, then defer the data clear with
  `setTimeout(..., 200)` (or use an `onCloseComplete` callback when
  the library exposes one).

- **`CREATE TABLE IF NOT EXISTS` is a no-op on existing tables** —
  reused workspaces / DBs do NOT pick up new columns added in the
  schema file. Symptom: runtime `no such column` after upgrade. Fix
  options: explicit `ALTER TABLE … ADD COLUMN IF NOT EXISTS` per
  drift; OR, if the DB has no production data, drop and re-bootstrap.

- **`hound::WavReader` only decodes WAV** — for `.mp3`/`.mp4`/`.m4a`/
  `.webm`, pipe through ffmpeg to `f32le @ 16 kHz mono` before
  feeding Whisper:

  ```rust
  // ffmpeg -hide_banner -loglevel error -nostdin -i <input>
  //   -ac 1 -ar 16000 -f f32le -
  let mut child = Command::new(ffmpeg)
      .args(["-hide_banner","-loglevel","error","-nostdin","-i"])
      .arg(input)
      .args(["-ac","1","-ar","16000","-f","f32le","-"])
      .stdout(Stdio::piped()).spawn()?;
  // read stdout, reinterpret bytes as &[f32]
  ```

## Definition of Done (Tauri)

For each change that touches `affected_paths` in **every affected
app** (monorepo: per-app):

1. `cargo check --manifest-path <app>/src-tauri/Cargo.toml --lib` green.
2. `bun run typecheck` (or `tsc --noEmit`) green.
3. `tauri-dev` showed `Finished` after the last `touch` in
   `<app>/src-tauri/src/**`.
4. Companion test exists (base TDD rule, if applicable).
5. **≥1 `mcp__tauri__webview_screenshot`** call after the last edit
   under `<app>/{src-tauri,src}/**`.
6. Post-operation state confirmed: DB query, DOM snapshot, or
   evidence visible in the screenshot.

The `tdd-session-audit.sh` Stop hook checks (1), (2), and (5)
automatically via the `tauri` template. Steps (3), (4), and (6) remain
agent responsibility.
