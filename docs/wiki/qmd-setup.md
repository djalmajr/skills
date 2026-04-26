# QMD Setup for the Wiki Skills

The wiki skills (`/wiki-ingest`, `/wiki-query`, `/wiki-lint`) prefer **[QMD](https://github.com/tobi/qmd)** (Query Markup Documents) as the retrieval engine when it is available. QMD is a local search engine for markdown that combines BM25, vector similarity, and LLM reranking — running entirely on-device via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp).

This document is the **owner-run setup guide**. The skills themselves never run `qmd embed` / `qmd update` / `qmd collection add` — those are deliberate human actions because they download large models and write to a shared SQLite index at `~/.cache/qmd/index.sqlite`.

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

The single biggest win is **context as a tree**: descriptions you attach per path get returned alongside any hit under that path. The skills rely on this to know things like "`raw/` is not the source of truth" without bloating prompts.

---

## Prerequisites

- **Node.js** ≥ 22 **or** **Bun** ≥ 1.0
- **macOS**: Homebrew SQLite for extension support
  ```sh
  brew install sqlite
  ```
- ~2 GB of disk for the local GGUF models (cached in `~/.cache/qmd/models/` after first use)

## Install QMD

Pick one:

```sh
# Global install with Bun (recommended in this project, since the rest of the stack uses Bun)
bun install -g @tobilu/qmd

# Or with npm
npm install -g @tobilu/qmd

# Or via the Claude Code plugin (registers the MCP server automatically)
claude plugin marketplace add tobi/qmd
claude plugin install qmd@qmd
```

Verify:
```sh
qmd status
```
A fresh install reports `totalDocuments: 0` and no collections.

---

## Embedding model — use Qwen3 for pt-BR / multilingual content

The default embedding model (`embeddinggemma-300M`) is English-optimized. If your wiki is in **Portuguese** (or any non-English language), set:

```sh
# Add to your shell profile (~/.zshrc or ~/.bashrc)
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Qwen3-Embedding-0.6B covers 119 languages (including pt-BR and full CJK) and ranks among the best multilingual embedding models on MTEB. The 0.6B variant is ~600 MB — bigger than the default but produces much better recall on non-English content.

If you already embedded with the default model, **re-embed everything** after switching:
```sh
qmd embed -f
```

---

## Recommended setup for the Zomme platform

The skills work best when **the wiki and its sibling product repos are all indexed as separate collections**. This lets `/wiki-query` answer "where is X documented?" across the whole monorepo-style layout, while `/wiki-lint` can detect when business rules leak into product repos.

```
~/Developer/zomme/
├── knowledge-base/      # ← the wiki itself (canonical source of truth)
├── skedly/              # product repo
├── kashes/              # product repo
├── simplifica/          # product repo (planned)
├── acmecorp.com/         # marketing site
└── platform/            # legacy monorepo (frozen)
```

### One-time setup (run from inside `knowledge-base/`)

```sh
# 1. The wiki itself — most important collection
qmd collection add . --name knowledge-base --mask "**/*.md"

# 2. Sibling product repos (only the markdown — code is irrelevant for wiki queries)
qmd collection add ../skedly --name skedly --mask "**/*.md"
qmd collection add ../kashes --name kashes --mask "**/*.md"
qmd collection add ../acmecorp.com --name site --mask "**/*.md"
qmd collection add ../platform --name platform-legacy --mask "**/*.md"
# Add ../simplifica when it exists.

# 3. Generate embeddings (downloads models on first run; takes a few minutes)
qmd embed
```

### Add hierarchical context — this is what makes QMD shine

```sh
# Global context applied to every result
qmd context add / "Plataforma Zomme: Skedly (agendamento), Kashes (financeiro), Simplifica (folha — planejado), acmecorp.com (site institucional). Wiki canônica em knowledge-base/."

# Wiki collection contexts
qmd context add qmd://knowledge-base/ "Wiki canônica da plataforma Zomme. Esta é a fonte de verdade para regras de negócio."
qmd context add qmd://knowledge-base/business "Regras de negócio (pricing, jornadas, riscos, oferta, papéis). Audience: business."
qmd context add qmd://knowledge-base/apps "Documentação técnica de aplicações. Audience: dev. NÃO contém regras de negócio — essas vivem em business/."
qmd context add qmd://knowledge-base/data "Schemas Drizzle e ENUMs de domínio. Audience: dev."
qmd context add qmd://knowledge-base/ops "Operações, infra, deploy. Audience: ops."
qmd context add qmd://knowledge-base/raw "Fontes brutas preservadas como referência histórica. NÃO é fonte de verdade — sempre confirmar contra a página final em business/, apps/, data/ ou ops/."
qmd context add qmd://knowledge-base/sources "Sumários de ingest. Cada arquivo descreve o que foi absorvido de uma fonte raw/ e quais páginas finais foram criadas/atualizadas."

# Product repo contexts
qmd context add qmd://skedly/ "Repo do produto Skedly (greenfield ativo). Stack TanStack Start + CF Workers + D1 + Better Auth embedded. Contém apenas regras técnicas — regras de negócio estão em ../knowledge-base/business/."
qmd context add qmd://kashes/ "Repo do produto Kashes (greenfield em construção). Mesma stack do Skedly. Regras de negócio em ../knowledge-base/business/."
qmd context add qmd://site/ "Site institucional acmecorp.com (Astro + CF Pages + D1). Marketing e waitlist."
qmd context add qmd://platform-legacy/ "Monorepo legado congelado em 2026-04-22. NÃO está sendo evoluído. Útil só como referência histórica."
```

> **Why these specific contexts?** They encode three rules the agents need to respect: (1) `wiki/business/` is the canonical home for business rules, (2) `raw/` is preserved but is not authoritative, (3) product repos hold only technical rules. With these contexts, search results carry that framing automatically — agents stop "discovering" rules in `raw/` or product repos and treating them as canonical.

### Verify

```sh
qmd status                          # see collections + doc counts
qmd context list                    # confirm contexts are attached
qmd query "qual a política de cancelamento do Skedly?"   # smoke test
```

---

## Keeping the index fresh

QMD does not auto-update. After changing the wiki:

```sh
qmd update                # rescan filesystem, re-index changed files
qmd embed                 # generate embeddings for new/changed chunks
```

Convenient one-liner you can drop in `~/Developer/zomme/knowledge-base/Makefile` or a project-specific shell alias:

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

✅ The skills **call** `mcp__qmd__query` / `mcp__qmd__get` / `mcp__qmd__status` and the `qmd query` / `qmd get` / `qmd status` CLI commands to answer questions and find related pages.

✅ At the end of an ingest or lint, the skills will **tell you** to run `qmd update` / `qmd embed` if the index has drifted.

❌ The skills **never** run `qmd embed`, `qmd update`, `qmd collection add`, `qmd collection remove`, or any command that mutates the index. Those are owner-controlled.

❌ The skills **never** assume QMD is installed. They detect it per-session and fall back to `grep` / `Read` / `wiki/index.md` when it is not configured.
