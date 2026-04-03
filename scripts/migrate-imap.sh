#!/usr/bin/env bash
set -euo pipefail

# IMAP migration via imapsync
#
# Usage:
#   ./scripts/migrate-imap.sh accounts.conf
#
# Config file format (one account per line):
#   source_user:source_password:dest_user:dest_password
#
# Environment:
#   SRC_HOST  — source IMAP host (default: mail.halogenos.org)
#   DST_HOST  — destination IMAP host (default: mail.halogenos.org)
#   DRY_RUN   — set to 1 for dry run (no writes)

SRC_HOST="${SRC_HOST:-mail.halogenos.org}"
DST_HOST="${DST_HOST:-mail.halogenos.org}"
DRY_RUN="${DRY_RUN:-0}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <accounts.conf>"
  echo ""
  echo "Config file format (one line per account):"
  echo "  source_user:source_password:dest_user:dest_password"
  echo ""
  echo "Environment variables:"
  echo "  SRC_HOST=$SRC_HOST"
  echo "  DST_HOST=$DST_HOST"
  echo "  DRY_RUN=$DRY_RUN"
  exit 1
fi

CONF="$1"

if [[ ! -f "$CONF" ]]; then
  echo "Error: config file not found: $CONF"
  exit 1
fi

if ! command -v imapsync &>/dev/null; then
  echo "Error: imapsync not found. Run with: nix-shell -p imapsync --run '$0 $*'"
  exit 1
fi

EXTRA_ARGS=()
if [[ "$DRY_RUN" == "1" ]]; then
  EXTRA_ARGS+=(--dry)
  echo "=== DRY RUN MODE ==="
fi

echo "Source: $SRC_HOST"
echo "Destination: $DST_HOST"
echo ""

LINE_NUM=0
SUCCEEDED=0
FAILED=0

while IFS=: read -r src_user src_pass dst_user dst_pass; do
  LINE_NUM=$((LINE_NUM + 1))

  # Skip empty lines and comments
  [[ -z "$src_user" || "$src_user" == \#* ]] && continue

  echo "━━━ Migrating: $src_user → $dst_user ━━━"

  if imapsync \
    --host1 "$SRC_HOST" --port1 993 --ssl1 --user1 "$src_user" --password1 "$src_pass" \
    --host2 "$DST_HOST" --port2 993 --ssl2 --user2 "$dst_user" --password2 "$dst_pass" \
    --automap --syncinternaldates \
    --exclude "(?i)spam|junk|trash" \
    --nofoldersizes \
    "${EXTRA_ARGS[@]}"; then
    echo "OK: $src_user → $dst_user"
    SUCCEEDED=$((SUCCEEDED + 1))
  else
    echo "FAIL: $src_user → $dst_user"
    FAILED=$((FAILED + 1))
  fi

  echo ""
done < "$CONF"

echo "━━━ Summary ━━━"
echo "  Succeeded: $SUCCEEDED"
echo "  Failed:    $FAILED"
