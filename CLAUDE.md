**CRITICAL**: These instructions are MANDATORY. Read all *.md files inside .agents/rules and its subfolders as well as ~/.agents/rules to get context and rules.

## Skill Templates

Templates that support a skill must live inside that skill folder, under `skills/<skill-name>/templates/`.

- Reference templates from `SKILL.md` using relative paths such as `templates/story.md`.
- Do not depend on global template paths such as `~/.agents/templates`.
- When adding or renaming a template, keep the `SKILL.md` reference and the bundled file in sync.

## Skill Evolution

Skills are expected to improve from real project usage.

- Prefer small, evidence-backed changes over broad rewrites.
- Capture the observed problem, affected skill/template, proposed change, and validation artifact.
- Use `/agile-skill-feedback` when evidence suggests a skill should be refined, merged, split, deprecated, removed, or created.
- Check for overlap before adding a new skill. Prefer improving or merging existing skills when that keeps routing clearer.
- Keep `SKILL.md` concise; move reusable detail into local `templates/`, `references/`, or `scripts/` only when it directly supports the skill.
- Validate changed skills against at least one realistic artifact before treating the change as ready.
- Human approval is required before applying AI-generated process changes that affect team workflow.

## Skill Prompting Conventions

When a skill needs a decision from the user, prefer the harness's structured-question tool over free-form chat. It reduces ambiguity, removes parsing of natural-language confirmations, and is portable across the three supported agents.

Tool by harness (same role, different name):

- Claude Code → `AskUserQuestion`
- Codex → `ask_user_question`
- OpenCode → `question`

**Use the structured tool when:**

- The choice is a small, discrete set (2-4 options), e.g. local vs shared, yes vs no with consequences, A/B/C tradeoffs.
- The decision branches the next steps the skill will take.
- A confirmation is required before something hard to undo (write, migrate, overwrite).
- Multiple items can be selected from a known list (multi-select where supported).

**Do NOT use the structured tool when:**

- The answer is free-form (paths, names, descriptions, justifications).
- It is a trivial confirmation that does not change behavior.
- The list of valid options is long enough that typing is faster than scanning.
- The skill can infer the answer from existing project state with high confidence.

When you do call a structured-question tool, label options clearly, mark the recommended one as such, and include a one-line description of each option's consequence. After the answer, restate the choice in your own words before acting on it.

Skills should describe these prompts at the SKILL.md level (the agent decides which tool to invoke based on the active harness). Do not hard-code a single tool name in the skill body.

<!-- ai-memory:start -->
## Long-term memory (ai-memory)

This project uses [ai-memory](https://github.com/akitaonrails/ai-memory)
for cross-session continuity.

**Default to the current project — always.** Every ai-memory tool
auto-scopes to the project resolved from your session's working
directory. **Do NOT pass `project` or `cwd` arguments unless the user
explicitly references a *different* project by name** (e.g. "what did we
decide in the `other-app` project?"). Phrases like "this project",
"here", "we", "our work", "where did we leave off" all mean the *current*
project — call the tool with no scoping args. If the user asks about a
handoff and the SessionStart auto-fetched block is already in your
context, just answer from it; do not re-call the tool to "find it again"
in another project.

**Lifecycle hooks already capture every prompt + tool call
automatically.** You never need to manually write routine notes; the
SessionStart hook auto-fetches pending handoffs, and on session end
ai-memory writes a session-summary page and a handoff.
LLM consolidation (compiling observations into topical wiki pages) runs
on PreCompact, on demand via `memory_consolidate`, and at session end
only when the server sets `AI_MEMORY_CONSOLIDATE_ON_SESSION_END`. Only
write a durable wiki page when the user explicitly asks to remember or
annotate something permanently.

### When to reach for each tool

The user can express any of the intents below in plain English —
match the intent to the tool. They do not need to name the tool.

| User says / situation | Tool |
|---|---|
| "have we discussed X?" / "search memory for Y" / before proposing architecture | `memory_query` (current project; `scopes` for named siblings; `global=true` to search every project) |
| "what's been going on" / "show recent activity" (light) | `memory_recent` |
| "is ai-memory healthy?" / "how big is the wiki?" | `memory_status` |
| "give me the stats" / structured snapshot for the agent to consume | `memory_briefing` (read-only; never creates handoffs) |
| "catch me up" / "I've been away" / "what's important right now?" / open-ended exploration | `memory_explore` |
| "where did we leave off?" — and you see a `📥 ai-memory: pending handoff` block in your context | already done — answer from that block; do NOT re-call `memory_handoff_accept` |
| "where did we leave off?" — and no such block is visible | `memory_handoff_accept` (rare; the SessionStart hook usually got there first) |
| "save context for the next session" / wrapping up / ending this session | `memory_handoff_begin` (session-end only; do **not** use for status/briefing; single-use handoff; terse summary; put detail in `open_questions` + `next_steps` bullets) |
| "discard that handoff" / "I created a handoff by mistake" | `memory_handoff_cancel` (requires exact `handoff_id` from `memory_handoff_begin`; marks it expired before the next session sees it) |
| "consolidate this session" / "compile what we learned" (also runs on PreCompact; at session end only if `AI_MEMORY_CONSOLIDATE_ON_SESSION_END` is set) | `memory_consolidate` |
| "remember this permanently" / "save a note" / "add an annotation" / durable project knowledge | `memory_write_page` (write a wiki page; do **not** use handoff for permanent notes; put the title as a `# H1` on the first line of `body` and omit the `title` arg — ai-memory derives it from the H1) |
| "read the page about X" / "show me the full content of Y" / "open the page on Z" | `memory_read_page` (full body; pass a query to search or `path` for a direct lookup; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "delete the page X" / "remove that note" | `memory_delete_page` (by exact `path`; idempotent; pass `workspace` + `project` together only for a named sibling workspace/project) |
| "audit the wiki" / "find contradictions" / "what rules should we add?" | `memory_lint` |
| "prune old pages" / "memory cleanup" | `memory_forget_sweep` |

`memory_explore` is the right default for the "I want to know what's
going on" use case — it returns a prose digest whose verbosity
scales automatically to how long it's been since the last activity
(< 1 h → one line; > 30 days → full catchup).

### When the current project comes up empty — broaden the search

`memory_query` searches only the **current** project by default. If a
search comes back empty or thin, the knowledge may live in a **sibling
project** — shared `infra`, `ops`, or a related app. Don't conclude
"we never recorded it" after a single project misses; broaden instead:

- **Know which projects to check?** Re-run with explicit `scopes`, e.g.
  `scopes: [{ "workspace": "default", "project": "infra" }]`.
- **Don't know where it lives?** Pass `global=true` to search every
  project in every workspace at once. Each hit is annotated with its
  workspace + project so you can tell where it came from. `global=true`
  cannot be combined with `scopes`/`project`/`workspace`.

`memory_query` returns **snippets, not full page bodies** — an empty or
short snippet does **not** mean the page is empty (a large page can
match outside the snippet window). To read the whole page, use
`memory_read_page` (by `path`, or pass a `query` to fetch the top hit's
full body; add `workspace` + `project` together only when the user names
a sibling workspace/project).

### When you write a project rule, write it here

If you're about to write a durable project rule ("always X", "never
Y", "all PRs must …"), this rules file (CLAUDE.md for Claude Code;
AGENTS.md for Codex / OpenCode / Cursor / Gemini CLI; whichever
convention your agent uses) is where it belongs. ai-memory's lint
pass surfaces the same hint automatically when a `kind: rule` page
lands in `_rules/`.

### Refreshing this snippet

This block is maintained by ai-memory. Two ways to refresh it with
the latest binary's recommended copy:

- **From the agent** (no terminal needed): ask "refresh the ai-memory
  routing in this project" — the agent calls
  `memory_install_self_routing`, picks the right filename for itself
  (Claude Code → `CLAUDE.md`; Codex / OpenCode / Cursor / Gemini →
  `AGENTS.md`), and uses its Write / Edit tool to land the block.
- **From the CLI**: `ai-memory install-instructions` (defaults to
  `CLAUDE.md`; pass `--target AGENTS.md` for non-Claude agents).

Both are idempotent: re-runs replace the block bracketed by
`<!-- ai-memory:start -->` / `<!-- ai-memory:end -->` markers
without disturbing the rest of the file.
<!-- ai-memory:end -->
