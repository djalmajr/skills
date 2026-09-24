// Leaf text helpers (port slice 4): no imports, so every module — state,
// herdr, lanes, quota — can share these without an import cycle.
//
// Ports: sanitize_cause (:793), redact_secrets (:1032) and has_word (:89) of
// scripts/herdr-agents.sh.

// sanitize_cause() port: one line, no tabs, control characters dropped
// (printables 0x20-0x7E only), runs of spaces collapsed, at most 200 chars.
export function sanitizeCause(s) {
  let out = String(s)
    .replace(/[\n\r\t]/g, ' ')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/g, '');
  return out.length > 200 ? out.slice(0, 200) : out;
}

// redact_secrets() port (the four sed -E passes, in order): key-shaped
// tokens with an underscore ((sk|pk|rk)_(live|test)_…), with a hyphen
// (sk-proj-…), Bearer tokens, and key=value.
export function redactSecrets(s) {
  return String(s)
    .replace(/(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[Bb]earer [A-Za-z0-9._~+/-]+/g, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)=[^ ]*/g, '$1=[redacted]');
}

// has_word <space-list> <word> — the bash `case " $1 " in *" $2 "*)`: the
// word (including spaces, like bash) appears as a space-delimited item.
export function hasWord(list, word) {
  return ` ${list} `.includes(` ${word} `);
}
