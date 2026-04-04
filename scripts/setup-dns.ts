#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

// ─── Usage ──────────────────────────────────────────────────────────────────

function usage(): never {
  console.log(`Usage: setup-dns.ts <mode> [options]

Modes:
  print    Print all required DNS records (no API access needed)
  check    Resolve records via DNS and show what's set vs missing
  apply    Upsert records via Cloudflare API (requires CF_API_TOKEN)

Options:
  --config <path>    Path to TOML config file (default: dns.toml)
  --env <path>       Path to .env file (default: .env)
  --ipv4 <ip>        Override server IPv4 address
  --ipv6 <ip>        Override server IPv6 address

Config file (dns.toml):
  [domain]
  org = "halogenos.org"
  mail = "mail.halogenos.org"       # default: mail.<org>
  sso = "sso.halogenos.org"         # default: sso.<org>
  webmail = "webmail.halogenos.org"  # default: webmail.<org>

  [server]
  ipv4 = "1.2.3.4"
  ipv6 = "2001:db8::1"              # optional

  [dkim]
  ed25519 = "tyzj..."               # public key only (no v=DKIM1 prefix)
  rsa = "MIIBIj..."                 # public key only

  [stalwart]
  url = "https://mail.halogenos.org"
  token = "..."
  cookie = "..."                    # optional

  [hetzner]
  server = "xos-core-infra-prod"    # server name for IP auto-detection + PTR

Environment files (.env, .env.local):
  CF_API_TOKEN=...
  CF_ZONE_ID=...                    # optional, auto-detected from domain
  HCLOUD_TOKEN=...                  # enables Hetzner IP auto-detection + PTR

  .env.local overrides .env and should not be committed.
  Secrets (API tokens) belong in .env.local.`);
  Deno.exit(1);
}

// ─── TOML parser (minimal, covers flat tables) ──────────────────────────────

function parseTOML(text: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentTable = "";

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const tableMatch = line.match(/^\[([a-zA-Z0-9_.-]+)\]$/);
    if (tableMatch) {
      currentTable = tableMatch[1];
      result[currentTable] ??= {};
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"(.*)"\s*$/);
    if (kvMatch && currentTable) {
      result[currentTable][kvMatch[1]] = kvMatch[2];
    }
  }
  return result;
}

// ─── .env parser ────────────────────────────────────────────────────────────

function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function loadEnvFiles(basePath: string): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const name of [".env", ".env.local"]) {
    const path = `${basePath}/${name}`;
    try {
      const text = Deno.readTextFileSync(path);
      Object.assign(merged, parseEnvFile(text));
    } catch {
      // File doesn't exist — that's fine
    }
  }

  return merged;
}

// ─── Config loading ─────────────────────────────────────────────────────────

interface Config {
  domain: {
    org: string;
    mail: string;
    sso: string;
    webmail: string;
  };
  server: {
    ipv4: string;
    ipv6: string;
  };
  dkim: {
    ed25519: string;
    rsa: string;
  };
  stalwart: {
    url: string;
    token: string;
    cookie: string;
  };
  hetzner: {
    server: string;
  };
  secrets: {
    cfApiToken: string;
    cfZoneId: string;
    hcloudToken: string;
  };
}

function cliOpt(name: string): string {
  const idx = Deno.args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < Deno.args.length) return Deno.args[idx + 1];
  return "";
}

function loadConfig(): Config {
  const scriptDir = new URL(".", import.meta.url).pathname;
  const configPath = cliOpt("config") || `${scriptDir}dns.toml`;

  let toml: Record<string, Record<string, string>> = {};
  try {
    toml = parseTOML(Deno.readTextFileSync(configPath));
  } catch {
    // No config file — rely on env/CLI
  }

  const envFiles = loadEnvFiles(scriptDir);

  // Helper: CLI > env file > process env > TOML > default
  const envGet = (key: string): string => {
    try { return Deno.env.get(key) ?? ""; } catch { return ""; }
  };
  const get = (cli: string, envKey: string, tomlSection: string, tomlKey: string, fallback = ""): string =>
    cliOpt(cli) ||
    envFiles[envKey] ||
    envGet(envKey) ||
    toml[tomlSection]?.[tomlKey] ||
    fallback;

  const org = get("domain", "ORG_DOMAIN", "domain", "org", "halogenos.org");

  return {
    domain: {
      org,
      mail: get("mail", "MAIL_DOMAIN", "domain", "mail", `mail.${org}`),
      sso: get("sso", "SSO_DOMAIN", "domain", "sso"),
      webmail: get("webmail", "WEBMAIL_DOMAIN", "domain", "webmail"),
    },
    server: {
      ipv4: get("ipv4", "SERVER_IPV4", "server", "ipv4"),
      ipv6: get("ipv6", "SERVER_IPV6", "server", "ipv6"),
    },
    dkim: {
      ed25519: get("", "DKIM_ED25519", "dkim", "ed25519"),
      rsa: get("", "DKIM_RSA", "dkim", "rsa"),
    },
    stalwart: {
      url: get("", "STALWART_URL", "stalwart", "url"),
      token: get("", "STALWART_TOKEN", "stalwart", "token"),
      cookie: get("", "STALWART_COOKIE", "stalwart", "cookie"),
    },
    hetzner: {
      server: get("", "HCLOUD_SERVER", "hetzner", "server"),
    },
    secrets: {
      cfApiToken: get("", "CF_API_TOKEN", "", ""),
      cfZoneId: get("", "CF_ZONE_ID", "", ""),
      hcloudToken: get("", "HCLOUD_TOKEN", "", ""),
    },
  };
}

// ─── Hetzner: resolve server IPs ────────────────────────────────────────────

interface HetznerServer {
  id: number;
  name: string;
  public_net: {
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
}

async function hcloudListServers(token: string): Promise<HetznerServer[]> {
  const resp = await fetch("https://api.hetzner.cloud/v1/servers?per_page=50", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`Hetzner API: ${resp.status} ${body}`);
  }
  const json = (await resp.json()) as { servers: HetznerServer[] };
  return json.servers;
}

let hetznerServerId: number | undefined;

async function resolveServerIPs(cfg: Config): Promise<void> {
  if (cfg.server.ipv4) return;

  if (!cfg.secrets.hcloudToken || !cfg.hetzner.server) {
    return;
  }

  const servers = await hcloudListServers(cfg.secrets.hcloudToken);
  const server = servers.find((s) => s.name === cfg.hetzner.server);
  if (!server) {
    console.error(`No Hetzner server named '${cfg.hetzner.server}'. Available: ${servers.map((s) => s.name).join(", ")}`);
    Deno.exit(1);
  }
  cfg.server.ipv4 = server.public_net.ipv4.ip;
  const v6prefix = server.public_net.ipv6.ip.replace(/\/\d+$/, "");
  cfg.server.ipv6 = cfg.server.ipv6 || `${v6prefix}1`;
  hetznerServerId = server.id;
  console.log(`Resolved ${cfg.hetzner.server}: ${cfg.server.ipv4} / ${cfg.server.ipv6}`);
}

// ─── Record definitions ─────────────────────────────────────────────────────

interface DesiredRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  srvData?: { weight: number; port: number; target: string };
  txtMatchPrefix?: string;
}

function buildInfraRecords(cfg: Config): DesiredRecord[] {
  const { org, mail, sso, webmail } = cfg.domain;
  const MTA_STS_HOST = `mta-sts.${org}`;
  const AUTOCONFIG_HOST = `autoconfig.${org}`;
  const AUTODISCOVER_HOST = `autodiscover.${org}`;
  const hosts = [mail, ...(sso ? [sso] : []), ...(webmail ? [webmail] : []), MTA_STS_HOST, AUTOCONFIG_HOST, AUTODISCOVER_HOST];

  const records: DesiredRecord[] = [];

  if (cfg.server.ipv4) {
    records.push(...hosts.map((h) => ({ type: "A", name: h, content: cfg.server.ipv4, proxied: false })));
  }
  if (cfg.server.ipv6) {
    records.push(...hosts.map((h) => ({ type: "AAAA", name: h, content: cfg.server.ipv6, proxied: false })));
  }

  records.push(
    {
      type: "TXT",
      name: `_mta-sts.${org}`,
      content: "v=STSv1; id=1",
      txtMatchPrefix: "v=STSv1",
    },
    {
      type: "SRV",
      name: `_autodiscover._tcp.${org}`,
      content: `0 1 443 ${AUTODISCOVER_HOST}.`,
      srvData: { weight: 1, port: 443, target: AUTODISCOVER_HOST },
      priority: 0,
    },
    {
      type: "SRV",
      name: `_carddavs._tcp.${org}`,
      content: `0 1 443 ${mail}.`,
      srvData: { weight: 1, port: 443, target: mail },
      priority: 0,
    },
    {
      type: "SRV",
      name: `_caldavs._tcp.${org}`,
      content: `0 1 443 ${mail}.`,
      srvData: { weight: 1, port: 443, target: mail },
      priority: 0,
    },
  );

  return records;
}

function buildMailFallbackRecords(cfg: Config): DesiredRecord[] {
  const { org, mail } = cfg.domain;

  const records: DesiredRecord[] = [
    { type: "MX", name: org, content: mail, priority: 10 },
    { type: "TXT", name: org, content: "v=spf1 mx ra=postmaster -all", txtMatchPrefix: "v=spf1" },
    {
      type: "TXT",
      name: `_dmarc.${org}`,
      content: `v=DMARC1; p=reject; rua=mailto:postmaster@${org}; ruf=mailto:postmaster@${org}`,
      txtMatchPrefix: "v=DMARC1",
    },
    {
      type: "TXT",
      name: `_smtp._tls.${org}`,
      content: `v=TLSRPTv1; rua=mailto:postmaster@${org}`,
      txtMatchPrefix: "v=TLSRPTv1",
    },
    {
      type: "SRV",
      name: `_imaps._tcp.${org}`,
      content: `0 1 993 ${mail}.`,
      srvData: { weight: 1, port: 993, target: mail },
      priority: 0,
    },
    {
      type: "SRV",
      name: `_submissions._tcp.${org}`,
      content: `0 1 465 ${mail}.`,
      srvData: { weight: 1, port: 465, target: mail },
      priority: 0,
    },
  ];

  if (cfg.dkim.ed25519) {
    const key = cfg.dkim.ed25519.replace(/^v=DKIM1;\s*k=ed25519;\s*p=/, "");
    records.push({
      type: "TXT",
      name: `ed._domainkey.${org}`,
      content: `v=DKIM1; k=ed25519; p=${key}`,
      txtMatchPrefix: "v=DKIM1; k=ed25519",
    });
  }
  if (cfg.dkim.rsa) {
    const key = cfg.dkim.rsa.replace(/^v=DKIM1;\s*k=rsa;\s*p=/, "");
    records.push({
      type: "TXT",
      name: `rsa._domainkey.${org}`,
      content: `v=DKIM1; k=rsa; p=${key}`,
      txtMatchPrefix: "v=DKIM1; k=rsa",
    });
  }

  return records;
}

// ─── Stalwart: fetch DNS records from live server ───────────────────────────

interface StalwartDnsRecord {
  type: string;
  name: string;
  content: string;
}

async function fetchStalwartRecords(cfg: Config): Promise<DesiredRecord[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.stalwart.token}` };
  if (cfg.stalwart.cookie) headers.Cookie = `_oauth2_proxy=${cfg.stalwart.cookie}`;
  const resp = await fetch(`${cfg.stalwart.url}/api/dns/records/${encodeURIComponent(cfg.domain.org)}`, { headers });
  if (!resp.ok) {
    throw new Error(`Stalwart API: ${resp.status} ${await resp.text().catch(() => "(no body)")}`);
  }
  const json = (await resp.json()) as { data: StalwartDnsRecord[] };

  const records: DesiredRecord[] = [];
  for (const r of json.data) {
    if (r.type === "TLSA") continue;
    const name = r.name.replace(/\.$/, "");

    switch (r.type) {
      case "MX": {
        const match = r.content.match(/^(\d+)\s+(.+?)\.?$/);
        if (match) {
          records.push({ type: "MX", name, content: match[2], priority: parseInt(match[1]) });
        }
        break;
      }
      case "SRV": {
        const match = r.content.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\.?$/);
        if (match) {
          records.push({
            type: "SRV", name, content: r.content,
            srvData: { weight: parseInt(match[2]), port: parseInt(match[3]), target: match[4] },
            priority: parseInt(match[1]),
          });
        }
        break;
      }
      case "TXT": {
        let txtMatchPrefix: string | undefined;
        if (r.content.startsWith("v=spf1")) txtMatchPrefix = "v=spf1";
        else if (r.content.startsWith("v=DMARC1")) txtMatchPrefix = "v=DMARC1";
        else if (r.content.startsWith("v=TLSRPTv1")) txtMatchPrefix = "v=TLSRPTv1";
        else if (r.content.startsWith("v=STSv1")) txtMatchPrefix = "v=STSv1";
        else if (r.content.startsWith("v=DKIM1; k=ed25519")) txtMatchPrefix = "v=DKIM1; k=ed25519";
        else if (r.content.startsWith("v=DKIM1; k=rsa")) txtMatchPrefix = "v=DKIM1; k=rsa";
        records.push({ type: "TXT", name, content: r.content, txtMatchPrefix });
        break;
      }
      case "CNAME":
        break;
      default:
        records.push({ type: r.type, name, content: r.content });
    }
  }
  return records;
}

async function buildRecords(cfg: Config): Promise<DesiredRecord[]> {
  const infra = buildInfraRecords(cfg);

  if (cfg.stalwart.url && cfg.stalwart.token) {
    console.log(`Fetching mail DNS records from Stalwart (${cfg.stalwart.url})...`);
    const stalwart = await fetchStalwartRecords(cfg);
    console.log(`  Got ${stalwart.length} records from Stalwart`);
    return [...infra, ...stalwart];
  }

  return [...infra, ...buildMailFallbackRecords(cfg)];
}

// ─── Print mode ─────────────────────────────────────────────────────────────

function formatRecord(rec: DesiredRecord): string {
  if (rec.type === "SRV" && rec.srvData) {
    const { weight, port, target } = rec.srvData;
    return `${rec.type}\t${rec.name}\t${rec.priority ?? 0} ${weight} ${port} ${target}`;
  }
  const pri = rec.priority !== undefined ? ` (priority: ${rec.priority})` : "";
  return `${rec.type}\t${rec.name}\t${rec.content}${pri}`;
}

function printRecords(cfg: Config, records: DesiredRecord[]): void {
  console.log(`Required DNS records for ${cfg.domain.org}:\n`);

  const grouped = new Map<string, DesiredRecord[]>();
  for (const rec of records) {
    const group = grouped.get(rec.type) ?? [];
    group.push(rec);
    grouped.set(rec.type, group);
  }

  for (const type of ["A", "AAAA", "MX", "TXT", "SRV", "CNAME"]) {
    const group = grouped.get(type);
    if (!group) continue;
    console.log(`── ${type} records ──`);
    for (const rec of group) console.log(`  ${formatRecord(rec)}`);
    console.log();
  }

  if (cfg.server.ipv4) {
    console.log(`── PTR records (set via hosting provider) ──`);
    console.log(`  PTR\t${cfg.server.ipv4}\t${cfg.domain.mail}`);
    if (cfg.server.ipv6) console.log(`  PTR\t${cfg.server.ipv6}\t${cfg.domain.mail}`);
    console.log();
  }

  console.log(`Total: ${records.length} records`);
}

// ─── Check mode ─────────────────────────────────────────────────────────────

async function resolve(name: string, type: string): Promise<string[]> {
  try {
    switch (type) {
      case "A":
      case "AAAA": {
        const results = await Deno.resolveDns(name, type as "A" | "AAAA");
        return results;
      }
      case "MX": {
        const results = await Deno.resolveDns(name, "MX");
        return results.map((r) => `${r.preference} ${r.exchange}`);
      }
      case "TXT": {
        const results = await Deno.resolveDns(name, "TXT");
        return results.map((r) => r.join(""));
      }
      case "SRV": {
        const results = await Deno.resolveDns(name, "SRV");
        return results.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.target}`);
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function contentMatches(resolved: string[], desired: DesiredRecord): boolean {
  switch (desired.type) {
    case "A":
    case "AAAA":
      return resolved.includes(desired.content);
    case "MX":
      return resolved.some((r) => {
        const match = r.match(/^(\d+)\s+(.+?)\.?$/);
        return match && parseInt(match[1]) === desired.priority && match[2].replace(/\.$/, "") === desired.content;
      });
    case "TXT":
      if (desired.txtMatchPrefix) {
        return resolved.some((r) => r.startsWith(desired.txtMatchPrefix!) && r === desired.content);
      }
      return resolved.includes(desired.content);
    case "SRV": {
      if (!desired.srvData) return false;
      const { weight, port, target } = desired.srvData;
      const expected = `${desired.priority ?? 0} ${weight} ${port} ${target}.`;
      return resolved.includes(expected);
    }
    default:
      return false;
  }
}

async function checkRecords(cfg: Config, records: DesiredRecord[]): Promise<void> {
  console.log(`Checking ${records.length} DNS records for ${cfg.domain.org}...\n`);

  let ok = 0;
  let missing = 0;
  let wrong = 0;

  for (const rec of records) {
    const resolved = await resolve(rec.name, rec.type);
    const matches = contentMatches(resolved, rec);

    if (matches) {
      console.log(`  ok     ${rec.type}\t${rec.name}`);
      ok++;
    } else if (rec.type === "TXT" || resolved.length === 0) {
      console.log(`  MISS   ${rec.type}\t${rec.name}`);
      console.log(`         expected: ${rec.content}`);
      missing++;
    } else {
      console.log(`  WRONG  ${rec.type}\t${rec.name}`);
      console.log(`         expected: ${rec.content}`);
      console.log(`         found:    ${resolved.join(", ")}`);
      wrong++;
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  ${ok} correct, ${missing} missing, ${wrong} wrong`);

  if (missing + wrong === 0) {
    console.log(`\nAll records are correctly configured.`);
  } else {
    console.log(`\n${missing + wrong} record(s) need attention.`);
    Deno.exit(1);
  }
}

// ─── Apply mode (Cloudflare upsert) ─────────────────────────────────────────

interface CFRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  data?: Record<string, unknown>;
}

function cfHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function cfResolveZoneId(token: string, domain: string): Promise<string> {
  console.log(`Resolving Cloudflare zone ID for ${domain}...`);
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`,
    { headers: cfHeaders(token) },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`Cloudflare zones API: ${resp.status} ${body}`);
  }
  const json = (await resp.json()) as { success: boolean; result: { id: string }[]; errors: unknown[] };
  if (!json.success || json.result.length === 0) {
    throw new Error(`Could not find Cloudflare zone for '${domain}': ${JSON.stringify(json.errors)}`);
  }
  const zoneId = json.result[0].id;
  console.log(`Zone ID: ${zoneId}`);
  return zoneId;
}

async function cfRequest(token: string, base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: cfHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "(no body)");
    throw new Error(`CF ${method} ${path}: HTTP ${resp.status} ${text}`);
  }
  const json = (await resp.json()) as { success: boolean; result: unknown; errors: unknown[] };
  if (!json.success) throw new Error(`CF ${method} ${path}: ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function cfListRecords(token: string, base: string): Promise<CFRecord[]> {
  const all: CFRecord[] = [];
  for (let page = 1; ; page++) {
    const resp = await fetch(`${base}?per_page=100&page=${page}`, { headers: cfHeaders(token) });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "(no body)");
      throw new Error(`Failed to list DNS records (page ${page}): HTTP ${resp.status} ${body}`);
    }
    const json = (await resp.json()) as {
      success: boolean;
      result: CFRecord[];
      result_info: { total_pages: number };
      errors: unknown[];
    };
    if (!json.success) {
      throw new Error(`Failed to list DNS records (page ${page}): ${JSON.stringify(json.errors)}`);
    }
    all.push(...json.result);
    if (page >= json.result_info.total_pages) break;
  }
  return all;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function findExisting(existing: CFRecord[], rec: DesiredRecord): CFRecord | undefined {
  return existing.find((e) => {
    if (e.type !== rec.type || e.name !== rec.name) return false;
    if (rec.txtMatchPrefix) return unquote(e.content).startsWith(rec.txtMatchPrefix);
    return true;
  });
}

function findDuplicates(existing: CFRecord[], rec: DesiredRecord): CFRecord[] {
  if (!rec.txtMatchPrefix) return [];
  return existing.filter((e) =>
    e.type === rec.type && e.name === rec.name && unquote(e.content).startsWith(rec.txtMatchPrefix!)
  );
}

function recordMatches(existing: CFRecord, desired: DesiredRecord): boolean {
  if (unquote(existing.content) !== desired.content) return false;
  if (desired.priority !== undefined && existing.priority !== desired.priority) return false;
  return true;
}

async function backupRecords(records: CFRecord[]): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = new URL("../dns-backups", import.meta.url).pathname;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${ts}.json`;
  await Deno.writeTextFile(path, JSON.stringify(records, null, 2) + "\n");
  console.log(`Backed up ${records.length} records to ${path}\n`);
}

async function applyRecords(cfg: Config, desired: DesiredRecord[]): Promise<void> {
  const token = cfg.secrets.cfApiToken;
  if (!token) {
    console.error("CF_API_TOKEN is required for apply mode (set in .env.local)");
    Deno.exit(1);
  }

  const cfZoneId = cfg.secrets.cfZoneId || (await cfResolveZoneId(token, cfg.domain.org));
  const cfBase = `https://api.cloudflare.com/client/v4/zones/${cfZoneId}/dns_records`;

  console.log(`Fetching existing DNS records...`);
  const existing = await cfListRecords(token, cfBase);
  console.log(`Found ${existing.length} existing records in zone`);

  await backupRecords(existing);

  const stats = { ok: 0, created: 0, updated: 0, deleted: 0, failed: 0 };

  for (const rec of desired) {
    const dupes = findDuplicates(existing, rec);
    if (dupes.length <= 1) continue;
    const keep = dupes.find((d) => d.content === rec.content) ?? dupes[0];
    for (const dupe of dupes) {
      if (dupe.id === keep.id) continue;
      try {
        console.log(`  dedup  ${dupe.type}\t${dupe.name}\t${dupe.content} → deleted`);
        await cfRequest(token, cfBase, "DELETE", `/${dupe.id}`);
        existing.splice(existing.indexOf(dupe), 1);
        stats.deleted++;
      } catch (e) {
        console.error(`  FAIL   dedup ${dupe.type}\t${dupe.name}: ${e instanceof Error ? e.message : e}`);
        stats.failed++;
      }
    }
  }

  for (let i = 0; i < desired.length; i++) {
    const rec = desired[i];
    const progress = `[${i + 1}/${desired.length}]`;
    const match = findExisting(existing, rec);

    if (match && recordMatches(match, rec)) {
      console.log(`  ${progress} ok   ${rec.type}\t${rec.name}\t${rec.content}`);
      stats.ok++;
      continue;
    }

    const body: Record<string, unknown> = rec.srvData
      ? {
          type: "SRV",
          name: rec.name,
          data: { ...rec.srvData, priority: rec.priority ?? 0 },
        }
      : {
          type: rec.type,
          name: rec.name,
          content: rec.content,
          proxied: rec.proxied ?? false,
          ttl: 1,
          ...(rec.priority !== undefined ? { priority: rec.priority } : {}),
        };

    try {
      if (match) {
        console.log(`  ${progress} upd  ${rec.type}\t${rec.name}\t${rec.content}`);
        await cfRequest(token, cfBase, "PUT", `/${match.id}`, body);
        stats.updated++;
      } else {
        console.log(`  ${progress} add  ${rec.type}\t${rec.name}\t${rec.content}`);
        await cfRequest(token, cfBase, "POST", "", body);
        stats.created++;
      }
    } catch (e) {
      console.error(`  ${progress} FAIL ${rec.type}\t${rec.name}\t${rec.content}`);
      console.error(`         ${e instanceof Error ? e.message : e}`);
      stats.failed++;
    }
  }

  // Hetzner PTR
  if (cfg.secrets.hcloudToken) {
    console.log("\nSetting PTR records via Hetzner Cloud API...");
    let serverId = hetznerServerId;
    if (!serverId) {
      const servers = await hcloudListServers(cfg.secrets.hcloudToken);
      const server = servers.find((s) => s.public_net.ipv4.ip === cfg.server.ipv4);
      if (!server) {
        console.error(`  No Hetzner server found with IP ${cfg.server.ipv4}`);
      } else {
        serverId = server.id;
      }
    }
    if (serverId) {
      const ips = [cfg.server.ipv4, ...(cfg.server.ipv6 ? [cfg.server.ipv6] : [])];
      for (const ip of ips) {
        try {
          const resp = await fetch(
            `https://api.hetzner.cloud/v1/servers/${serverId}/actions/change_dns_ptr`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${cfg.secrets.hcloudToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ ip, dns_ptr: cfg.domain.mail }),
            },
          );
          if (!resp.ok) {
            console.error(`  FAIL PTR\t${ip}: HTTP ${resp.status}`);
            stats.failed++;
          } else {
            console.log(`  ok   PTR\t${ip} → ${cfg.domain.mail}`);
          }
        } catch (e) {
          console.error(`  FAIL PTR\t${ip}: ${e instanceof Error ? e.message : e}`);
          stats.failed++;
        }
      }
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  ${stats.ok} unchanged, ${stats.created} created, ${stats.updated} updated, ${stats.deleted} deduped, ${stats.failed} failed`);

  if (stats.failed > 0) {
    console.error(`\n${stats.failed} operation(s) failed.`);
    Deno.exit(1);
  }
  console.log("\nDone.");
}

// ─── Main ───────────────────────────────────────────────────────────────────

try {
  const MODE = Deno.args[0];
  if (!MODE || !["print", "check", "apply"].includes(MODE)) usage();

  const cfg = loadConfig();
  await resolveServerIPs(cfg);

  if (!cfg.server.ipv4 && MODE !== "print") {
    console.error("Server IP required for check/apply. Set [server] ipv4 in dns.toml, or provide HCLOUD_TOKEN + [hetzner] server.");
    Deno.exit(1);
  }

  console.log(`\nDNS setup for ${cfg.domain.org}`);
  console.log(`  Mail:    ${cfg.domain.mail}`);
  if (cfg.domain.sso) console.log(`  SSO:     ${cfg.domain.sso}`);
  if (cfg.domain.webmail) console.log(`  Webmail: ${cfg.domain.webmail}`);
  if (cfg.server.ipv4) console.log(`  Server:  ${cfg.server.ipv4}${cfg.server.ipv6 ? ` / ${cfg.server.ipv6}` : ""}`);
  console.log(`  Mode:    ${MODE}\n`);

  const desired = await buildRecords(cfg);

  switch (MODE) {
    case "print":
      printRecords(cfg, desired);
      break;
    case "check":
      await checkRecords(cfg, desired);
      break;
    case "apply":
      await applyRecords(cfg, desired);
      break;
  }
} catch (e) {
  console.error(`\nFatal: ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}
