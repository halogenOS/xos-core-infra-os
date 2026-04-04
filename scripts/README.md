# Migration Scripts

## migrate-imap.sh

Migrates mailboxes from the existing mailcow instance to the new Stalwart
mail server using `imapsync`.

### Prerequisites

```
nix-shell -p imapsync
```

### Usage

```
./scripts/migrate-imap.sh accounts.conf
```

### Config file format

One account per line, colon-separated:

```
source_user:source_password:dest_user:dest_password
```

Lines starting with `#` are ignored.

### Environment variables

| Variable   | Default              | Description                     |
|------------|----------------------|---------------------------------|
| `SRC_HOST` | *(required)*         | Source IMAP host (mailcow)      |
| `DST_HOST` | *(required)*         | Destination IMAP host (stalwart)|
| `DRY_RUN`  | `0`                  | Set to `1` for a dry run        |

### Notes

- Spam, junk, and trash folders are excluded by default.
- Uses `--automap` to match folder names between servers.
- `--syncinternaldates` preserves original message timestamps.
- Run with `DRY_RUN=1` first to verify the migration plan.
