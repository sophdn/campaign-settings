#!/usr/bin/env bash
#
# Dependency-advisory gate.
#
# `pnpm audit` alone is not a gate: it exits non-zero for as long as any known
# advisory exists, so a repo with one accepted finding either fails forever or
# gets the check removed. Both outcomes end with nobody watching.
#
# So this compares the CURRENT findings against `.audit-allowlist` and fails on
# the difference, in both directions:
#
#   * an advisory that is not allowlisted  -> fail (something new arrived)
#   * an allowlisted advisory that is gone -> fail (the waiver is stale)
#
# The second is the one that earns its keep. A waiver nobody removes is how a
# fixed problem stays documented as accepted, and how the next reviewer learns
# to trust the file less.
#
# Usage: bash scripts/audit-gate.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ALLOWLIST=.audit-allowlist

# `pnpm audit` exits non-zero whenever findings exist, which is the normal case
# here — so its status says nothing and is deliberately discarded. A genuine
# failure (no network, no registry) shows up as unparseable output below.
raw="$(pnpm audit --json 2>/dev/null || true)"

if ! printf '%s' "$raw" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  echo "audit-gate: could not read 'pnpm audit --json'." >&2
  echo "  The registry is usually the reason. This gate does not pass silently when" >&2
  echo "  it cannot check — if you are genuinely offline, bypass with --no-verify" >&2
  echo "  and re-run before pushing anything you would deploy." >&2
  exit 1
fi

found="$(printf '%s' "$raw" | python3 -c '
import json, sys
adv = json.load(sys.stdin).get("advisories") or {}
seen = {}
for a in adv.values():
    gid = a.get("github_advisory_id")
    if gid:
        seen[gid] = (a.get("severity", "?"), a.get("module_name", "?"), a.get("title", ""))
for gid, (sev, mod, title) in sorted(seen.items()):
    print(f"{gid}\t{sev}\t{mod}\t{title}")
')"

allowed="$(grep -vE '^\s*(#|$)' "$ALLOWLIST" 2>/dev/null | awk '{print $1}' | sort -u || true)"
found_ids="$(printf '%s' "$found" | awk -F'\t' 'NF{print $1}' | sort -u || true)"

status=0

unexpected="$(comm -23 <(printf '%s\n' "$found_ids" | grep -v '^$' || true) \
                        <(printf '%s\n' "$allowed"   | grep -v '^$' || true) || true)"
if [ -n "$unexpected" ]; then
  status=1
  echo "audit-gate: NEW advisories, not in $ALLOWLIST:" >&2
  while IFS= read -r gid; do
    [ -z "$gid" ] && continue
    printf '%s' "$found" | awk -F'\t' -v g="$gid" '$1==g {printf "  [%s] %s — %s\n    %s\n", $2, $3, $4, "https://github.com/advisories/" $1}' >&2
  done <<< "$unexpected"
  echo "  Fix it, or add it to $ALLOWLIST with a reason that says why it is unreachable." >&2
fi

stale="$(comm -13 <(printf '%s\n' "$found_ids" | grep -v '^$' || true) \
                   <(printf '%s\n' "$allowed"   | grep -v '^$' || true) || true)"
if [ -n "$stale" ]; then
  status=1
  echo "audit-gate: STALE waivers in $ALLOWLIST — these advisories no longer appear:" >&2
  while IFS= read -r gid; do
    [ -z "$gid" ] && continue
    echo "  $gid" >&2
  done <<< "$stale"
  echo "  The problem is fixed. Delete the line." >&2
fi

if [ "$status" -eq 0 ]; then
  n="$(printf '%s\n' "$found_ids" | grep -c . || true)"
  echo "audit-gate: OK — $n known advisor$([ "$n" = 1 ] && echo y || echo ies), all allowlisted with a reason."
fi
exit "$status"
