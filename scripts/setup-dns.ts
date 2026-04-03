#!/usr/bin/env -S deno run --allow-net --allow-env

// ─── Environment ─────────────────────────────────────────────────────────────

function env(name: string, required = true): string {
  const val = Deno.env.get(name) ?? "";
  if (!val && required) {
    console.error(`Missing required env var: ${name}`);
    Deno.exit(1);
  }
  return val;
}

const CF_ZONE = "halogenos.org";
const DOMAIN = env("ORG_DOMAIN");
const MAIL_HOST = env("MAIL_DOMAIN");
const SSO_HOST = env("SSO_DOMAIN");
const WEBMAIL_HOST = env("WEBMAIL_DOMAIN");

const CF_API_TOKEN = env("CF_API_TOKEN");
const HCLOUD_TOKEN = env("HCLOUD_TOKEN", false);
const HCLOUD_SERVER = env("HCLOUD_SERVER", false);
const DKIM_ED25519_VALUE = env("DKIM_ED25519", false);
const DKIM_RSA_VALUE = env("DKIM_RSA", false);

const STALWART_URL = env("STALWART_URL", false);
const STALWART_TOKEN = env("STALWART_TOKEN", false);
const STALWART_COOKIE = env("STALWART_COOKIE", false);

// ─── Hetzner: resolve server IPs ─────────────────────────────────────────────

interface HetznerServer {
  id: number;
  name: string;
  public_net: {
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
}

async function hcloudListServers(): Promise<HetznerServer[]> {
  const resp = await fetch("https://api.hetzner.cloud/v1/servers?per_page=50", {
    headers: { Authorization: `Bearer ${HCLOUD_TOKEN}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`Hetzner API: ${resp.status} ${body}`);
  }
  const json = (await resp.json()) as { servers: HetznerServer[] };
  return json.servers;
}

let SERVER_IPV4 = env("SERVER_IPV4", false);
let SERVER_IPV6 = env("SERVER_IPV6", false);
let hetznerServerId: number | undefined;

if (!SERVER_IPV4) {
  if (!HCLOUD_TOKEN || !HCLOUD_SERVER) {
    console.error("Provide SERVER_IPV4 or both HCLOUD_TOKEN + HCLOUD_SERVER to auto-detect IPs");
    Deno.exit(1);
  }
  const servers = await hcloudListServers();
  const server = servers.find((s) => s.name === HCLOUD_SERVER);
  if (!server) {
    console.error(`No Hetzner server named '${HCLOUD_SERVER}'. Available: ${servers.map((s) => s.name).join(", ")}`);
    Deno.exit(1);
  }
  SERVER_IPV4 = server.public_net.ipv4.ip;
  // Hetzner gives a /64 prefix for IPv6 — use the ::1 address
  const v6prefix = server.public_net.ipv6.ip.replace(/\/\d+$/, "");
  SERVER_IPV6 = SERVER_IPV6 || `${v6prefix}1`;
  hetznerServerId = server.id;
  console.log(`Resolved ${HCLOUD_SERVER}: ${SERVER_IPV4} / ${SERVER_IPV6}`);
}

// ─── Cloudflare: resolve zone ID ─────────────────────────────────────────────

const cfHeaders = {
  Authorization: `Bearer ${CF_API_TOKEN}`,
  "Content-Type": "application/json",
};

async function cfResolveZoneId(domain: string): Promise<string> {
  console.log(`Resolving Cloudflare zone ID for ${domain}...`);
  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(domain)}`,
    { headers: cfHeaders },
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

const CF_ZONE_ID = env("CF_ZONE_ID", false) || (await cfResolveZoneId(CF_ZONE));

// ─── Cloudflare API ──────────────────────────────────────────────────────────

interface CFRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  data?: Record<string, unknown>;
}

const CF_BASE = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`;

async function cfRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${CF_BASE}${path}`, {
    method,
    headers: cfHeaders,
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

async function cfListRecords(): Promise<CFRecord[]> {
  const all: CFRecord[] = [];
  for (let page = 1; ; page++) {
    const resp = await fetch(`${CF_BASE}?per_page=100&page=${page}`, { headers: cfHeaders });
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

// ─── Stalwart: fetch DNS records from live server ───────────────────────────

interface StalwartDnsRecord {
  type: string;
  name: string;
  content: string;
}

async function fetchStalwartRecords(domain: string): Promise<DesiredRecord[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${STALWART_TOKEN}` };
  if (STALWART_COOKIE) headers.Cookie = `_oauth2_proxy=${STALWART_COOKIE}`;
  const resp = await fetch(`${STALWART_URL}/api/dns/records/${encodeURIComponent(domain)}`, { headers });
  if (!resp.ok) {
    throw new Error(`Stalwart API: ${resp.status} ${await resp.text().catch(() => "(no body)")}`);
  }
  const json = (await resp.json()) as { data: StalwartDnsRecord[] };

  const records: DesiredRecord[] = [];
  for (const r of json.data) {
    // Skip TLSA — cert-dependent, goes stale on renewal
    if (r.type === "TLSA") continue;

    // Strip trailing dots from names
    const name = r.name.replace(/\.$/, "");

    switch (r.type) {
      case "MX": {
        const match = r.content.match(/^(\d+)\s+(.+?)\.?$/);
        if (match) {
          records.push({
            type: "MX",
            name,
            content: match[2],
            priority: parseInt(match[1]),
          });
        }
        break;
      }
      case "SRV": {
        const match = r.content.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\.?$/);
        if (match) {
          const priority = parseInt(match[1]);
          const weight = parseInt(match[2]);
          const port = parseInt(match[3]);
          const target = match[4];
          records.push({
            type: "SRV",
            name,
            content: r.content,
            srvData: { weight, port, target },
            priority,
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
      case "CNAME": {
        // Stalwart generates CNAMEs for autoconfig/autodiscover/mta-sts;
        // we use A/AAAA records instead since Caddy handles TLS — skip them
        break;
      }
      default:
        records.push({ type: r.type, name, content: r.content });
    }
  }

  return records;
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

function buildInfraRecords(): DesiredRecord[] {
  const MTA_STS_HOST = `mta-sts.${DOMAIN}`;
  const AUTOCONFIG_HOST = `autoconfig.${DOMAIN}`;
  const AUTODISCOVER_HOST = `autodiscover.${DOMAIN}`;
  const hosts = [MAIL_HOST, SSO_HOST, WEBMAIL_HOST, MTA_STS_HOST, AUTOCONFIG_HOST, AUTODISCOVER_HOST];

  return [
    ...hosts.map((h) => ({ type: "A", name: h, content: SERVER_IPV4, proxied: false })),

    ...(SERVER_IPV6
      ? hosts.map((h) => ({ type: "AAAA", name: h, content: SERVER_IPV6, proxied: false }))
      : []),

    {
      type: "TXT",
      name: `_mta-sts.${DOMAIN}`,
      content: "v=STSv1; id=1",
      txtMatchPrefix: "v=STSv1",
    },

    {
      type: "SRV",
      name: `_autodiscover._tcp.${DOMAIN}`,
      content: `0 1 443 ${AUTODISCOVER_HOST}.`,
      srvData: { weight: 1, port: 443, target: AUTODISCOVER_HOST },
      priority: 0,
    },

    {
      type: "SRV",
      name: `_carddavs._tcp.${DOMAIN}`,
      content: `0 1 443 ${MAIL_HOST}.`,
      srvData: { weight: 1, port: 443, target: MAIL_HOST },
      priority: 0,
    },

    {
      type: "SRV",
      name: `_caldavs._tcp.${DOMAIN}`,
      content: `0 1 443 ${MAIL_HOST}.`,
      srvData: { weight: 1, port: 443, target: MAIL_HOST },
      priority: 0,
    },
  ];
}

function buildMailFallbackRecords(): DesiredRecord[] {
  const records: DesiredRecord[] = [
    { type: "MX", name: DOMAIN, content: MAIL_HOST, priority: 10 },
    { type: "TXT", name: DOMAIN, content: "v=spf1 mx -all", txtMatchPrefix: "v=spf1" },

    {
      type: "TXT",
      name: `_dmarc.${DOMAIN}`,
      content: `v=DMARC1; p=reject; rua=mailto:postmaster@${DOMAIN}`,
      txtMatchPrefix: "v=DMARC1",
    },

    {
      type: "TXT",
      name: `_smtp._tls.${DOMAIN}`,
      content: `v=TLSRPTv1; rua=mailto:postmaster@${DOMAIN}`,
      txtMatchPrefix: "v=TLSRPTv1",
    },

    {
      type: "SRV",
      name: `_imaps._tcp.${DOMAIN}`,
      content: `0 1 993 ${MAIL_HOST}.`,
      srvData: { weight: 1, port: 993, target: MAIL_HOST },
      priority: 0,
    },

    {
      type: "SRV",
      name: `_submissions._tcp.${DOMAIN}`,
      content: `0 1 465 ${MAIL_HOST}.`,
      srvData: { weight: 1, port: 465, target: MAIL_HOST },
      priority: 0,
    },
  ];

  if (DKIM_ED25519_VALUE) {
    const key = DKIM_ED25519_VALUE.replace(/^v=DKIM1;\s*k=ed25519;\s*p=/, "");
    records.push({
      type: "TXT",
      name: `ed._domainkey.${DOMAIN}`,
      content: `v=DKIM1; k=ed25519; p=${key}`,
      txtMatchPrefix: "v=DKIM1; k=ed25519",
    });
  }
  if (DKIM_RSA_VALUE) {
    const key = DKIM_RSA_VALUE.replace(/^v=DKIM1;\s*k=rsa;\s*p=/, "");
    records.push({
      type: "TXT",
      name: `rsa._domainkey.${DOMAIN}`,
      content: `v=DKIM1; k=rsa; p=${key}`,
      txtMatchPrefix: "v=DKIM1; k=rsa",
    });
  }

  return records;
}

async function buildRecords(): Promise<DesiredRecord[]> {
  const infra = buildInfraRecords();

  if (STALWART_URL && STALWART_TOKEN) {
    console.log(`Fetching mail DNS records from Stalwart (${STALWART_URL})...`);
    const stalwart = await fetchStalwartRecords(DOMAIN);
    console.log(`  Got ${stalwart.length} records from Stalwart`);
    return [...infra, ...stalwart];
  }

  console.log("No STALWART_URL — using fallback mail records");
  return [...infra, ...buildMailFallbackRecords()];
}

// ─── Upsert logic ────────────────────────────────────────────────────────────

// Cloudflare sometimes wraps TXT content in literal quotes
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
    e.type === rec.type && e.name === rec.name && unquote(e.content).startsWith(rec.txtMatchPrefix)
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

async function upsertRecords(desired: DesiredRecord[]): Promise<{ ok: number; created: number; updated: number; deleted: number; failed: number }> {
  console.log(`Fetching existing DNS records...`);
  const existing = await cfListRecords();
  console.log(`Found ${existing.length} existing records in zone`);

  await backupRecords(existing);

  const stats = { ok: 0, created: 0, updated: 0, deleted: 0, failed: 0 };

  // First pass: deduplicate TXT records that share a prefix (e.g. multiple SPF records)
  for (const rec of desired) {
    const dupes = findDuplicates(existing, rec);
    if (dupes.length <= 1) continue;

    // Keep the one whose content matches desired, or the first one
    const keep = dupes.find((d) => d.content === rec.content) ?? dupes[0];
    for (const dupe of dupes) {
      if (dupe.id === keep.id) continue;
      try {
        console.log(`  dedup  ${dupe.type}\t${dupe.name}\t${dupe.content} → deleted (keeping ${keep.content})`);
        await cfRequest("DELETE", `/${dupe.id}`);
        existing.splice(existing.indexOf(dupe), 1);
        stats.deleted++;
      } catch (e) {
        console.error(`  FAIL   dedup ${dupe.type}\t${dupe.name}: ${e instanceof Error ? e.message : e}`);
        stats.failed++;
      }
    }
  }

  // Second pass: upsert
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
          data: {
            ...rec.srvData,
            priority: rec.priority ?? 0,
          },
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
        await cfRequest("PUT", `/${match.id}`, body);
        stats.updated++;
      } else {
        console.log(`  ${progress} add  ${rec.type}\t${rec.name}\t${rec.content}`);
        await cfRequest("POST", "", body);
        stats.created++;
      }
    } catch (e) {
      console.error(`  ${progress} FAIL ${rec.type}\t${rec.name}\t${rec.content}`);
      console.error(`         ${e instanceof Error ? e.message : e}`);
      stats.failed++;
    }
  }

  return stats;
}

// ─── Hetzner PTR ─────────────────────────────────────────────────────────────

async function setHetznerPTR(): Promise<{ ok: number; failed: number }> {
  if (!HCLOUD_TOKEN) {
    console.log("\nSkipping PTR (no HCLOUD_TOKEN)");
    return { ok: 0, failed: 0 };
  }

  console.log("\nSetting PTR records via Hetzner Cloud API...");

  let serverId = hetznerServerId;
  if (!serverId) {
    const servers = await hcloudListServers();
    const server = servers.find((s) => s.public_net.ipv4.ip === SERVER_IPV4);
    if (!server) {
      console.error(`  No Hetzner server found with IP ${SERVER_IPV4}`);
      return { ok: 0, failed: 1 };
    }
    serverId = server.id;
    console.log(`  Found server: ${server.name} (${serverId})`);
  }

  const stats = { ok: 0, failed: 0 };
  const ips = [SERVER_IPV4, ...(SERVER_IPV6 ? [SERVER_IPV6] : [])];

  for (const ip of ips) {
    try {
      const resp = await fetch(
        `https://api.hetzner.cloud/v1/servers/${serverId}/actions/change_dns_ptr`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HCLOUD_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ip, dns_ptr: MAIL_HOST }),
        },
      );

      if (!resp.ok) {
        const body = await resp.text().catch(() => "(no body)");
        console.error(`  FAIL PTR\t${ip}: HTTP ${resp.status} ${body}`);
        stats.failed++;
      } else {
        console.log(`  ok   PTR\t${ip} → ${MAIL_HOST}`);
        stats.ok++;
      }
    } catch (e) {
      console.error(`  FAIL PTR\t${ip}: ${e instanceof Error ? e.message : e}`);
      stats.failed++;
    }
  }

  return stats;
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  console.log(`\nSetting up DNS for ${DOMAIN}`);
  console.log(`  Mail:    ${MAIL_HOST}`);
  console.log(`  SSO:     ${SSO_HOST}`);
  console.log(`  Webmail: ${WEBMAIL_HOST}`);
  console.log(`  Server:  ${SERVER_IPV4}${SERVER_IPV6 ? ` / ${SERVER_IPV6}` : ""}`);
  console.log(`  DKIM:    Ed25519=${DKIM_ED25519_VALUE ? "yes" : "no"}, RSA=${DKIM_RSA_VALUE ? "yes" : "no"}`);
  console.log(`  Stalwart: ${STALWART_URL ? STALWART_URL : "not configured (using fallback records)"}\n`);

  const desired = await buildRecords();
  console.log(`Upserting ${desired.length} Cloudflare DNS records...`);
  const dns = await upsertRecords(desired);

  const ptr = await setHetznerPTR();

  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log(`  DNS records: ${dns.ok} unchanged, ${dns.created} created, ${dns.updated} updated, ${dns.deleted} deleted, ${dns.failed} failed`);
  if (ptr.ok || ptr.failed) {
    console.log(`  PTR records: ${ptr.ok} ok, ${ptr.failed} failed`);
  }

  const totalFailed = dns.failed + ptr.failed;
  if (totalFailed > 0) {
    console.error(`\n${totalFailed} operation(s) failed.`);
    Deno.exit(1);
  }

  console.log("\nDone.");
} catch (e) {
  console.error(`\nFatal: ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}
