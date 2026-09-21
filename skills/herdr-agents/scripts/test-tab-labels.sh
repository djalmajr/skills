#!/usr/bin/env bash
# Unit checks for herd-tab labels: role abbreviations, the `herd_label`
# template, truncation and " 2" suffixes, the 3-column state file (with the
# migration of the old one-column list), manual > auto precedence, renames
# done in Herdr by hand, `spawn --tab-label` routing and the `tab-label`
# command. Pure functions run on fixtures; the rest runs against a fake
# `herdr` in PATH whose tab labels live in files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SCRIPT="$SCRIPT_DIR/herdr-agents.sh"
TEST_ROOT="$(mktemp -d)"
trap 'find "$TEST_ROOT" -depth -delete' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect() { # <label> <got> <want>
  [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"
}

# shellcheck source=herdr-agents.sh
HERDR_AGENTS_LIB=1 HOME="$TEST_ROOT/home" XDG_CONFIG_HOME="$TEST_ROOT/config" . "$SKILL_SCRIPT"
load_config

# --- abbreviations ---------------------------------------------------------
expect 'implementer' "$(role_abbrev implementer)" impl
expect 'security-reviewer' "$(role_abbrev security-reviewer)" sec
expect 'sub-orchestrator' "$(role_abbrev sub-orchestrator)" sub
expect 'project role keeps its file name' "$(role_abbrev solid-ui)" solid-ui

# --- template --------------------------------------------------------------
expect 'default: distinct roles, arrival order' "$(compose_herd_label '{roles}' 'implementer reviewer implementer' 1)" 'impl+rev'
expect 'single role' "$(compose_herd_label '{roles}' 'scouter' 1)" 'scout'
expect 'no worker yet' "$(compose_herd_label '{roles}' '' 1)" ''
expect '{n} counts workers, not roles' "$(compose_herd_label '{roles} ({n})' 'implementer reviewer implementer' 1)" 'impl+rev (3)'
expect '{i} empty on the first tab' "$(compose_herd_label '{roles} {i}' 'implementer' 1)" 'impl'
expect '{i} is the position from 2' "$(compose_herd_label '{roles} {i}' 'implementer' 3)" 'impl 3'
expect '{orch}' "$(compose_herd_label '{orch}: {roles}' 'designer solid-ui' 1 orchestrator-2)" 'orchestrator-2: des+solid-ui'

# --- truncation and suffixes -----------------------------------------------
expect 'short label untouched' "$(herd_auto_label 'impl+rev' '')" 'impl+rev'
expect 'cut to 16 characters' "$(herd_auto_label 'impl+rev+insp+des+scout' '')" 'impl+rev+insp+de'
expect 'no dangling separator after the cut' "$(herd_auto_label 'impl+rev+insp+de+scout' '')" 'impl+rev+insp+de'
expect 'repeated label gets " 2"' "$(herd_auto_label 'impl+rev' $'impl+rev\n')" 'impl+rev 2'
expect 'then " 3"' "$(herd_auto_label 'impl+rev' $'impl+rev\nimpl+rev 2\n')" 'impl+rev 3'
expect 'suffix fits inside the 16' "$(herd_auto_label 'impl+rev+insp+des+scout' $'impl+rev+insp+de\n')" 'impl+rev+insp 2'
expect 'empty base falls back to herd' "$(herd_auto_label '' '')" 'herd'
HERDR_AGENTS_HERD_LABEL_MAX=6 expect 'herd_label_max from config' "$(HERDR_AGENTS_HERD_LABEL_MAX=6 herd_auto_label 'impl+rev' '')" 'impl+r'

# --- fake herdr: tab labels live in files ----------------------------------
FAKE="$TEST_ROOT/bin"; TABS="$TEST_ROOT/tabs"; LOG="$TEST_ROOT/herdr.log"; mkdir -p "$FAKE" "$TABS"
cat > "$FAKE/herdr" <<FAKE_EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LOG"
T="$TABS"
case "\$1 \$2" in
  "tab get") [ -f "\$T/\$3" ] || { echo '{"error":"tab_not_found"}'; exit 1; }
             printf '{"result":{"tab":{"tab_id":"%s","label":"%s"}}}\n' "\$3" "\$(cat "\$T/\$3")" ;;
  "tab rename") shift 2; id="\$1"; shift; printf '%s' "\$*" > "\$T/\$id"; echo '{"result":{}}' ;;
  "tab list") printf '{"result":{"tabs":['; sep=""; for f in "\$T"/*; do printf '%s{"tab_id":"%s","label":"%s"}' "\$sep" "\$(basename "\$f")" "\$(cat "\$f")"; sep=,; done; printf ']}}\n' ;;
  "tab create") n="t\$(( \$(ls "\$T" | wc -l) + 1 ))"; while [ -f "\$T/\$n" ]; do n="\${n}x"; done
                l=""; while [ \$# -gt 0 ]; do [ "\$1" = --label ] && l="\$2"; shift; done; printf '%s' "\$l" > "\$T/\$n"
                printf '{"result":{"tab":{"tab_id":"%s"},"root_pane":{"pane_id":"root-%s"}}}\n' "\$n" "\$n" ;;
  "pane list") cat "$TEST_ROOT/panes.json" ;;
  "pane layout") echo '{"result":{"layout":{"panes":[{"pane_id":"x","rect":{"x":0,"y":0,"width":213,"height":28}}]}}}' ;;
  "pane split") echo '{"result":{"pane":{"pane_id":"split-of-'"\$3"'"}}}' ;;
  "agent get") echo '{"result":{"agent":{"name":"'"\$3"'"}}}' ;;
  *) echo '{"error":"unexpected: '"\$*"'"}' >&2; exit 1 ;;
esac
FAKE_EOF
chmod +x "$FAKE/herdr"
STATE="$TEST_ROOT/state"; mkdir -p "$STATE/ws"
export PATH="$FAKE:$PATH" HERDR_AGENTS_DIR="$STATE" HERDR_WORKSPACE_ID=ws HERDR_ENV=1 HERDR_TAB_ID=caller HERDR_PANE_ID=c
panes() { # "<pane> <tab>"… → panes.json
  local out="" p; for p in "$@"; do out="$out{\"pane_id\":\"${p% *}\",\"tab_id\":\"${p#* }\"},"; done
  printf '{"result":{"panes":[%s]}}' "${out%,}" > "$TEST_ROOT/panes.json"
}
roster() { # "<name> <pane> <role>"… → agents.tsv
  { printf '# name\tpane\tkind\trole\tfamily\tcreated_pane\tcwd\tstarted\n'
    local r; for r in "$@"; do read -r n p role <<< "$r"; printf '%s\t%s\tclaude\t%s\tanthropic\t1\t/tmp\tnow\n' "$n" "$p" "$role"; done; } > "$STATE/ws/agents.tsv"
}
state() { tr '\n\t' ' ,' < "$STATE/ws/herd-tab"; }

# --- state file: migration of the old one-column list ----------------------
printf 'herd\n' > "$TABS/t1"; printf 'onda 2\n' > "$TABS/t2"; : > "$TABS/t3"
printf 't1\nt2\nt3\ngone\n' > "$STATE/ws/herd-tab"
panes; roster
expect 'migration: herd-N → auto, hand label → manual, no label → auto, dead pruned' "$(herd_tab_entries | tr '\n\t' ' ,')" 't1,herd,auto t2,onda 2,manual t3,-,auto '
expect 'file rewritten in the 3-column format' "$(state)" 't1,herd,auto t2,onda 2,manual t3,-,auto '

# --- relabel: auto from roles, manual kept, repeats suffixed, empty → herd --
panes 'w1 t1' 'w2 t1' 'w3 t1' 'w4 t2' 'w5 t3' 'w6 t3'
roster 'impl w1 implementer' 'rev w2 reviewer' 'impl-2 w3 implementer' 'des w4 designer' 'impl-3 w5 implementer' 'rev-2 w6 reviewer'
: > "$LOG"
herd_tabs_relabel
expect 'auto labels written' "$(state)" 't1,impl+rev,auto t2,onda 2,manual t3,impl+rev 2,auto '
expect 't1 renamed in Herdr' "$(cat "$TABS/t1")" 'impl+rev'
expect 'manual tab not renamed' "$(cat "$TABS/t2")" 'onda 2'
expect 'repeated roles → " 2"' "$(cat "$TABS/t3")" 'impl+rev 2'
: > "$LOG"; herd_tabs_relabel
grep -q 'tab rename' "$LOG" && fail "relabel must not rename when nothing changed: $(cat "$LOG")"
# a released worker changes the label; a tab left without workers shows `herd`
roster 'impl w1 implementer' 'impl-2 w3 implementer' 'des w4 designer'
herd_tabs_relabel
expect 'after release' "$(state)" 't1,impl,auto t2,onda 2,manual t3,herd,auto '
# custom template
HERDR_AGENTS_HERD_LABEL='{orch}·{roles}{i}' HERDR_AGENTS_HERD_LABEL_MAX=40 herd_tabs_relabel
expect 'custom template with {orch} and {i}' "$(state)" 't1,c·impl,auto t2,onda 2,manual t3,c·3,auto '
herd_tabs_relabel

# --- rename done in Herdr by hand is respected (manual > auto) --------------
printf 'onda 3' > "$TABS/t1"
herd_tabs_relabel
expect 'hand rename → manual, kept' "$(state)" 't1,onda 3,manual t2,onda 2,manual t3,herd,auto '
expect 'tab label untouched' "$(cat "$TABS/t1")" 'onda 3'

# --- herd_tab_pane with a manual label ------------------------------------
export HERDR_AGENTS_SPLIT_MAX_PANES=2
: > "$LOG"
expect 'label with room → split its last pane' "$(herd_tab_pane /tmp 'onda 2' reviewer)" $'split-of-w4\t1'
grep -q '^pane split w4' "$LOG" || fail "expected a split in t2 (onda 2), log: $(cat "$LOG")"
roster 'impl w1 implementer' 'impl-2 w3 implementer' 'des w4 designer' 'rev w7 reviewer'; panes 'w1 t1' 'w3 t1' 'w4 t2' 'w7 t2' 's3 t3'
: > "$LOG"
expect 'label full → next tab "<label> ·2"' "$(herd_tab_pane /tmp 'onda 2' reviewer)" $'root-t4\t1'
grep -q 'tab create .*--label onda 2 ·2' "$LOG" || fail "expected a tab labelled 'onda 2 ·2', log: $(cat "$LOG")"
expect 'manual tab recorded' "$(state)" 't1,onda 3,manual t2,onda 2,manual t3,herd,auto t4,onda 2 ·2,manual '
expect 'new manual label → created as manual' "$(herd_tab_pane /tmp 'paridade' implementer)" $'root-t5\t1'
expect 'auto path: first tab with room (t3, a shell in it)' "$(herd_tab_pane /tmp '' scouter)" $'split-of-s3\t1'
expect 'placement splits the last pane of that tab' "$(tail -n1 "$LOG")" 'pane split s3 --direction down --cwd /tmp --no-focus'
expect 'auto label deduped against existing ones' "$(HERDR_AGENTS_SPLIT_MAX_PANES=0 herd_tab_pane /tmp '' implementer)" $'root-t6\t1'
expect 'auto tab recorded' "$(tail -n1 "$STATE/ws/herd-tab" | tr '\t' ',')" 't6,impl,auto'

# --- tab-label command ------------------------------------------------------
OUT="$(cmd_tab_label)"
grep -q '^t2 *onda 2 *manual$' <<< "$OUT" || fail "tab-label list: $OUT"
expect 'pin a label on the newest herd tab' "$(cmd_tab_label paridade · onda 2 2>/dev/null | jq -r '.tab + "|" + .label + "|" + .mode')" 't6|paridade · onda 2|manual'
expect 'tab renamed' "$(cat "$TABS/t6")" 'paridade · onda 2'
expect 'pin on a given tab' "$(cmd_tab_label --tab t3 revisao | jq -r '.label + "|" + .mode')" 'revisao|manual'
expect 'back to auto' "$(cmd_tab_label --tab t3 --auto | jq -r '.label + "|" + .mode')" 'herd|auto'
expect 'auto again: no worker, "herd" taken by t3 → "herd 2"' "$(cmd_tab_label --tab t6 --auto | jq -r '.label')" 'herd 2'
( cmd_tab_label --tab nope x >/dev/null 2>&1 ) && fail 'tab-label must refuse a tab it does not track'
expect 'warns on long labels' "$(cmd_tab_label --tab t3 'um rótulo comprido demais para a sidebar' 2>&1 >/dev/null | grep -c 'longer than 16')" 1

# --- spawn --tab-label is parsed and forces the herd placement --------------
grep -q -- '--tab-label) tab_label="$2"' "$SKILL_SCRIPT" || fail 'spawn: --tab-label option missing'
grep -q 'herd_tab_pane "$cwd" "$tab_label" "$role"' "$SKILL_SCRIPT" || fail 'spawn: --tab-label not passed to herd_tab_pane'
grep -q -- '--approvals|--tab-label)' "$SKILL_SCRIPT" || fail 'run: --tab-label option is not forwarded to spawn'

# --- run --no-wait returns after dispatch instead of collecting too early ---
cmd_spawn() { printf '{"name":"runner"}\n'; }
cmd_dispatch() { printf 'dispatch:%s\n' "$*"; }
cmd_collect() { printf 'collect:%s\n' "$*"; }
OUT="$(cmd_run reviewer /tmp/brief.md --no-wait)"
grep -q '^dispatch:runner /tmp/brief.md --no-wait$' <<< "$OUT" || fail "run --no-wait did not dispatch: $OUT"
grep -q '^collect:' <<< "$OUT" && fail "run --no-wait collected before the worker finished: $OUT"
OUT="$(cmd_run reviewer /tmp/brief.md)"
grep -q '^collect:runner$' <<< "$OUT" || fail "waiting run did not collect: $OUT"

echo 'tab-label checks passed'
