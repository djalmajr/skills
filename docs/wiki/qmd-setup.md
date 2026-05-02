# QMD Setup for the Wiki Skills

The wiki skills (`/wiki-ingest`, `/wiki-query`, `/wiki-lint`) prefer **[QMD](https://github.com/tobi/qmd)** (Query Markup Documents) as the retrieval engine when it is available. QMD is a local search engine for markdown that combines BM25, vector similarity, and LLM reranking — running entirely on-device via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp).

This document is the **human setup and troubleshooting guide**. For normal project onboarding, start with `/wiki-init doctor`: the skill diagnoses the project, suggests the wiki path and index, and can prepare a managed QMD checkout plus per-project wrappers after explicit confirmation. Manual commands below are still useful for owners who want to inspect or operate QMD directly.

---

## Why QMD over plain `grep` / `Read`

| Capability | grep / Read | QMD |
|---|---|---|
| Exact term match | ✅ | ✅ (BM25) |
| Semantic search ("how does payment work?") | ❌ | ✅ (vector) |
| Cross-document reranking | ❌ | ✅ (qwen3-reranker) |
| **Per-path context injection** | ❌ | ✅ (the killer feature — see below) |
| Cross-repo search across siblings | manual | ✅ (multiple collections) |
| Score-based filtering for agents | ❌ | ✅ (`--min-score`) |

The single biggest win is **context as a tree**: descriptions you attach per path get returned alongside any hit under that path. The skills rely on this to know things like "raw sources are not the source of truth" without bloating prompts.

---

## Prerequisites

- **Node.js** ≥ 22 **or** **Bun** ≥ 1.0
- **macOS**: Homebrew SQLite for extension support
  ```sh
  brew install sqlite
  ```
- ~2 GB of disk for the local GGUF models (cached in `~/.cache/qmd/models/` after first use)

## Running QMD — managed wrapper first

For projects initialized by `wiki-init`, prefer the generated project wrapper instead of a global `qmd` binary or shell alias. The wrapper points at the skill-managed checkout under `~/.local/share/essential-skills/qmd/checkouts/qmd` and has a provenance manifest under the skill cache.

Manual `bunx @tobilu/qmd` remains useful for experimentation or for projects that intentionally do not use `wiki-init`, but it is no longer the recommended default for this skill package. The rest of this guide uses `qmd` as a placeholder for either the generated wrapper or a manually installed QMD command.

### MCP integration — pick one

Stdio mode (default in Claude Code MCP config) re-launches the binary every session, so cold start matters. Three options:

- **Claude Code plugin** (recommended for most users — handles install + MCP registration)
  ```sh
  claude plugin marketplace add tobi/qmd
  claude plugin install qmd@qmd
  ```
- **Background HTTP daemon** (ideal if multiple agents hit QMD — see the daemon section below). Pair with `bunx` freely; the daemon starts once and stays warm.
- **Direct `bunx` in MCP config** — simplest, accepts a small per-session cold start.

Verify:
```sh
qmd status
```
A fresh install reports `totalDocuments: 0` and no collections.

---

## Embedding model — pick the right one for your content language

The default embedding model (`embeddinggemma-300M`) is English-optimized. If your wiki is in **any non-English language** (Portuguese, Spanish, German, Japanese, Chinese, etc.), set:

```sh
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Qwen3-Embedding-0.6B covers 119 languages and ranks among the best multilingual embedding models on MTEB. The 0.6B variant is ~600 MB — bigger than the default but produces much better recall on non-English content.

### Persisting alias + var in your shell rc

This snippet detects your active shell (zsh, bash, or fish), writes both the `qmd` alias and the `QMD_EMBED_MODEL` export to the matching rc file, and is idempotent — running it twice will not duplicate the lines:

```sh
ALIAS_LINE="alias qmd='bunx @tobilu/qmd'"
QMD_VAR='QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"'
case "$SHELL" in
  */zsh)  RC="$HOME/.zshrc"; EXPORT_LINE="export $QMD_VAR" ;;
  */bash) RC="$HOME/.bashrc"; [ ! -f "$RC" ] && RC="$HOME/.bash_profile"
          EXPORT_LINE="export $QMD_VAR" ;;
  */fish) RC="$HOME/.config/fish/config.fish"
          EXPORT_LINE='set -gx QMD_EMBED_MODEL "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"' ;;
  *) echo "Unsupported shell: $SHELL — configure manually."; return 1 ;;
esac
mkdir -p "$(dirname "$RC")" && touch "$RC"
grep -qF "alias qmd=" "$RC" || printf '\n# QMD CLI alias\n%s\n' "$ALIAS_LINE" >> "$RC"
grep -qF 'QMD_EMBED_MODEL' "$RC" || printf '\n# QMD multilingual embedding model\n%s\n' "$EXPORT_LINE" >> "$RC"
echo "QMD configured in $RC. Re-open the shell or run: source $RC"
```

Skip the alias block (`grep -qF "alias qmd=" ... || ...`) if you installed globally and prefer the bare `qmd` binary. Skip the `QMD_EMBED_MODEL` block if your wiki is in English (the default model is fine).

Reload the rc (`source ~/.zshrc` etc.) or open a new shell so `qmd` sees the var.

If you already embedded with the default model, **re-embed everything** after switching:
```sh
qmd embed -f
```

---

## Setting up collections

Each collection is an indexed root path. The default — and recommended — setup is **a single collection: the wiki itself**.

### One-time setup (run from inside the wiki repo)

```sh
qmd collection add . --name <wiki-name> --mask "**/*.md"
qmd embed   # downloads models on first run; takes a few minutes
```

### Why only the wiki — and not the sibling product repos

It is tempting to index every sibling repo (`../<product-a>/`, `../<product-b>/`) so `/wiki-query` can answer cross-repo questions. The wiki skills push back on this for a reason:

- The skills' working assumption is that **the wiki is the single canonical source of business knowledge**. Indexing product repos invites agents to "discover" content there and treat it as authoritative — the exact drift these skills are designed to prevent.
- Cross-repo audits (e.g. "did a business rule leak into the product repo's `CLAUDE.md`?") are part of `/wiki-lint`, which performs them with `grep` / `Read` against the sibling repos. No QMD index needed for that.
- Every additional collection is one more thing to keep up to date with `qmd update` — extra friction for a marginal use case.

If your project has a genuine need for cross-repo semantic search (e.g. a wiki that explicitly aggregates technical docs from many repos and treats those as part of its canonical surface), feel free to add additional collections — just be deliberate about it and reflect that intent in the contexts you attach.

### Add hierarchical context — this is what makes QMD shine

`context` is metadata attached to a path inside a collection. Every result under that path is returned with the context string, which lets you encode rules **once** instead of repeating them in every page or prompt.

The contexts you add depend on your project's conventions. Two categories pay off the most:

1. **Audience separation** — tell QMD which folders hold business rules, technical docs, ops procedures, raw sources, etc. Agents will respect the split when synthesizing answers and when deciding where to ingest a new source.
2. **Truth markers** — flag folders that are **not** authoritative (e.g. `raw/` preserved sources, `archive/` deprecated content, `*-legacy.md`).

Generic shape:

```sh
# Global context (applies to every result)
qmd context add / "<one-paragraph summary of what the wiki contains and what it is canonical for>"

# Per-folder context inside the wiki collection
qmd context add qmd://<wiki-name>/<folder> "<what this folder contains; flag the audience>"
qmd context add qmd://<wiki-name>/raw "<flag raw sources as preserved-but-not-canonical>"
```

> **Why these contexts matter.** Without them, agents tend to "discover" content in `raw/` or other non-canonical folders and treat it as authoritative, which leads to drift. With contexts, every result already carries that framing.

Project-specific examples (collection names, context strings, language) belong **in the wiki repo itself**, not in this skills repo. Any project that uses these skills should add a `QMD.md` (or similar) at the wiki root with the exact commands the owner needs to run for that project.

### Verify

```sh
qmd status                          # see collections + doc counts
qmd context list                    # confirm contexts are attached
qmd query "<a real question your wiki should answer>"   # smoke test
```

---

## Keeping the index fresh

QMD does not auto-update. After changing the wiki:

```sh
qmd update                # rescan filesystem, re-index changed files
qmd embed                 # generate embeddings for new/changed chunks
```

Convenient one-liner you can drop in a `Makefile` or a project-specific shell alias:

```makefile
qmd-refresh:
	qmd update && qmd embed
```

`/wiki-lint` will tell you when the index drifts (`needsEmbedding > 0` or doc-count mismatch).

---

## Optional: shared MCP daemon

If multiple Claude Code sessions or other MCP clients hit QMD, run it once as a background HTTP daemon to keep models loaded in memory:

```sh
qmd mcp --http --daemon            # starts on localhost:8181
qmd status                          # shows "MCP: running (PID ...)"
qmd mcp stop                        # later, when you want it down
```

Then point clients at `http://localhost:8181/mcp` instead of spawning a new stdio subprocess each session.

---

## What the skills will and will not do

✅ `wiki-query`, `wiki-ingest`, and `wiki-lint` call QMD read/status commands when available and fall back to filesystem search when QMD is missing.

✅ `wiki-init` may prepare a managed QMD checkout, wrappers, manifests, MCP config, and hooks after explicit user confirmation. It must not patch or install QMD globally.

✅ Project hooks may run `qmd update` / `qmd embed` after wiki markdown edits when the project opts into that guardrail. Hook failures should be logged loudly and remain non-blocking unless the project policy says otherwise.

❌ No wiki skill should silently create a collection, change the canonical wiki path, or choose a QMD index without the user confirming the project topology.

❌ The skills must not assume QMD is installed globally. They should prefer the project wrapper when configured, then MCP/CLI discovery, then direct markdown search.
