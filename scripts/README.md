# Scripts

## setup-dns.ts

Generates, checks, and applies DNS records for a mail server setup
(Stalwart + optional SSO + optional webmail). Works with any domain.

### Prerequisites

[Deno](https://deno.land) runtime.

### Quick start

```sh
# Print all DNS records you need to create for your domain
./scripts/setup-dns.ts print --domain example.com --ipv4 203.0.113.1

# Check which ones are already set
./scripts/setup-dns.ts check --domain example.com --ipv4 203.0.113.1

# Apply them via Cloudflare
CF_API_TOKEN=... ./scripts/setup-dns.ts apply --domain example.com --ipv4 203.0.113.1
```

### Modes

| Mode    | Description                                    | API keys needed |
|---------|------------------------------------------------|-----------------|
| `print` | Print all required DNS records                 | None            |
| `check` | Resolve each record via DNS, report status     | None            |
| `apply` | Upsert records via Cloudflare, set Hetzner PTR | CF_API_TOKEN    |

### Configuration

Settings are read from multiple sources (highest priority first):

1. CLI flags (`--domain`, `--ipv4`, etc.)
2. `.env.local` (gitignored — for secrets)
3. `.env`
4. Process environment variables
5. `dns.toml`
6. Built-in defaults

All subdomains default from the org domain:
`mail.<org>`, `sso.<org>`, `webmail.<org>`. Only `mail` is required —
`sso` and `webmail` are included only when explicitly set.

#### dns.toml

```toml
[domain]
org = "example.com"
# mail = "mail.example.com"       # default: mail.<org>
# sso = "sso.example.com"         # omit if not using SSO
# webmail = "webmail.example.com"  # omit if not using webmail

[server]
ipv4 = "203.0.113.1"
# ipv6 = "2001:db8::1"

[dkim]
# ed25519 = "tyzj..."             # public key (no v=DKIM1 prefix)
# rsa = "MIIBIj..."

[stalwart]
# url = "https://mail.example.com" # fetch records from live Stalwart
# token = "..."

[hetzner]
# server = "my-server"            # auto-detect IPs + set PTR
```

#### .env.local

Secrets — not committed. Their presence enables the corresponding features.

```sh
CF_API_TOKEN=...      # required for apply mode
HCLOUD_TOKEN=...      # enables Hetzner IP auto-detection + PTR
CF_ZONE_ID=...        # optional, skips zone ID lookup
```

### Step-by-step setup

#### 1. Generate the record list

Start with just your domain and server IP:

```sh
./scripts/setup-dns.ts print --domain example.com --ipv4 203.0.113.1
```

This prints all the DNS records you need to create at your DNS provider.
Create them manually (or use `apply` mode if you're on Cloudflare).

#### 2. Set up DKIM

Once your mail server is running, it generates DKIM signing keys. You
need to publish the public keys as DNS TXT records so receiving servers
can verify your signatures.

**Option A: Fetch from a running Stalwart instance**

If your Stalwart server is already running, the script can pull the DKIM
keys directly from its API:

```sh
./scripts/setup-dns.ts print \
  --domain example.com --ipv4 203.0.113.1 \
  --stalwart-url https://mail.example.com \
  --stalwart-token your-api-token
```

Or in `dns.toml`:

```toml
[stalwart]
url = "https://mail.example.com"
token = "your-api-token"
```

**Option B: Provide the keys manually**

Copy the public key values from your mail server's DKIM settings and
add them to `dns.toml`. Use just the key material, not the full TXT
record value:

```toml
[dkim]
ed25519 = "tyzjKFPslK..."
rsa = "MIIBIjANBgkq..."
```

The script wraps these into the correct `v=DKIM1; k=ed25519; p=...`
format automatically.

#### 3. Verify

Check that all records resolve correctly:

```sh
./scripts/setup-dns.ts check --domain example.com --ipv4 203.0.113.1
```

The check uses live DNS resolution. TXT records are checked for presence
only (not exact value match), so existing SPF/DMARC records with
different parameters won't be flagged as wrong.

#### 4. Ongoing

Re-run `check` after DNS changes or server migrations to verify
everything is in order. If you rotate DKIM keys, update `dns.toml`
or re-fetch from Stalwart and run `apply` again.

### Records generated

The script generates the following records. All are standard for a
mail server setup — you can create them at any DNS provider.

- **A/AAAA** — mail, mta-sts, autoconfig, autodiscover (+ sso, webmail if configured)
- **MX** — mail server for the org domain
- **TXT** — SPF (`v=spf1 mx ra=postmaster -all`), DMARC, MTA-STS, TLS-RPT, DKIM (Ed25519 + RSA)
- **SRV** — IMAP (`_imaps`), SMTP submission (`_submissions`), autodiscover, CardDAV, CalDAV
- **PTR** — reverse DNS for the server IP (set via Hetzner API if `HCLOUD_TOKEN` is present, otherwise set manually at your hosting provider)

---

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
