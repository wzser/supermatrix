import fs from "node:fs";
import path from "node:path";

const AMAZON_MARKETPLACE_SUFFIXES = [
  "com",
  "ca",
  "com.mx",
  "com.br",
  "co.uk",
  "de",
  "fr",
  "it",
  "es",
  "nl",
  "se",
  "pl",
  "com.tr",
  "ae",
  "sa",
  "in",
  "sg",
  "eg",
  "co.jp",
  "com.au",
  "com.be"
];

export function parseAliases(raw = "") {
  const lines = raw.split(/\r?\n/);
  const markers = lines.flatMap((line, index) => /^---\s*$/.test(line) ? [index] : []);
  if (markers.length < 2) return [];

  const frontmatter = lines.slice(markers[0] + 1, markers[1]);
  for (let i = 0; i < frontmatter.length; i++) {
    const line = frontmatter[i];
    const inline = line.match(/^\s*aliases:\s*\[(.*)\]\s*$/);
    if (inline) return splitAliases(inline[1]);

    if (!/^\s*aliases:\s*$/.test(line)) continue;

    const aliases = [];
    for (let j = i + 1; j < frontmatter.length; j++) {
      const aliasLine = frontmatter[j];
      if (/^\s*-\s+/.test(aliasLine)) {
        aliases.push(cleanAlias(aliasLine.replace(/^\s*-\s*/, "")));
      } else if (aliasLine.trim() === "") {
        continue;
      } else {
        break;
      }
    }

    return aliases;
  }

  return [];
}

function cleanAlias(rawValue = "") {
  return rawValue.trim().replace(/^["']|["']$/g, "");
}

function splitAliases(rawValues = "") {
  return rawValues
    .split(",")
    .map(cleanAlias)
    .filter(Boolean);
}

export function stripFrontmatter(raw = "") {
  const fences = [...raw.matchAll(/^---\s*$/gm)];
  if (fences.length < 2) return raw.trim();
  return raw.slice(fences[1].index + fences[1][0].length).replace(/^\r?\n/, "").trim();
}

export function matchSitePatterns({ query = "", dir }) {
  if (!query || !dir || !fs.existsSync(dir)) return [];

  const hostTokens = getHostTokens(query);
  const queryForAliases = stripHostTokensFromText(query, hostTokens);
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const domain = entry.name.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
    const aliases = parseAliases(raw);
    const pattern = aliases
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .map((value) => `(?:^|[^A-Za-z0-9_])${value}(?:$|[^A-Za-z0-9_])`)
      .join("|");

    const domainMatch = hostTokens.some((host) => isHostMatchForDomain(domain, host));
    const aliasMatch = pattern.length > 0 ? new RegExp(pattern, "i").test(queryForAliases) : false;
    if (!domainMatch && !aliasMatch) continue;

    results.push({
      domain,
      aliases,
      body: stripFrontmatter(raw),
      raw
    });
  }

  return results;
}

function isHostMatchForDomain(domain = "", host = "") {
  if (!host || !domain) return false;

  const normalizedHost = host.toLowerCase();
  const normalizedDomain = domain.toLowerCase();

  if (normalizedDomain === "amazon.com") {
    return isAmazonRetailHost(normalizedHost);
  }

  if (normalizedDomain === "members.helium10.com") {
    return normalizedHost === normalizedDomain;
  }

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function isAmazonRetailHost(host = "") {
  return AMAZON_MARKETPLACE_SUFFIXES.some((suffix) => {
    const base = `amazon.${suffix}`;
    if (host === base) return true;
    const trailing = `.${base}`;
    if (!host.endsWith(trailing)) return false;
    const prefix = host.slice(0, -trailing.length);
    return prefix === "www";
  });
}

function getHostTokens(raw = "") {
  const hosts = new Set();

  const query = raw.toLowerCase();

  for (const match of query.matchAll(/https?:\/\/[^\s\]\)\}\>"']+/g)) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // Intentionally ignore malformed URLs.
    }
  }

  for (const match of query.matchAll(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])+)+(?:\.[a-z]{2,})?\b/g)) {
    hosts.add(match[0]);
  }

  return [...hosts];
}

function stripHostTokensFromText(raw = "", hostTokens = []) {
  let cleaned = raw;
  for (const token of hostTokens) {
    const safeToken = escapeRegExp(token);
    cleaned = cleaned.replace(new RegExp(safeToken, "gi"), " ");
  }

  return cleaned.replace(/https?:\/\/[^\s\]\)\}\>"']+/g, " ");
}

function escapeRegExp(value = "") {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
