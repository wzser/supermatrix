export const MODES = ["generic", "amzlisting", "amzh10"];

const AMAZON_PDP_PATH_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\//i;

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

const EXPLICIT_HINTS = [
  { pattern: /\/?\s*web\s*access\s+amzlisting\b/i, mode: "amzlisting" },
  { pattern: /\/?\s*web\s*access\s+amzh10\b/i, mode: "amzh10" },
  { pattern: /\/?\s*web\s*access\s+generic\b/i, mode: "generic" },
  { pattern: /\buse\s+web\s*access\s+amzlisting\b/i, mode: "amzlisting" },
  { pattern: /\buse\s+web\s*access\s+amzh10\b/i, mode: "amzh10" },
  { pattern: /\buse\s+web\s*access\s+generic\b/i, mode: "generic" },
  { pattern: /用\s*web\s*access\s*跑\s*amzlisting/i, mode: "amzlisting" },
  { pattern: /用\s*web\s*access\s*跑\s*amzh10/i, mode: "amzh10" },
  { pattern: /用\s*web\s*access\s*跑\s*generic/i, mode: "generic" }
];

export function getHostname(url = "") {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isAmazonHostname(hostname) {
  return AMAZON_MARKETPLACE_SUFFIXES.some((suffix) => {
    const amazonDomain = `amazon.${suffix}`;
    if (hostname === amazonDomain) return true;

    const trailing = `.${amazonDomain}`;
    if (!hostname.endsWith(trailing)) return false;

    const prefix = hostname.slice(0, -trailing.length);
    return prefix === "www";
  });
}

export function isAmazonRetailUrl(url = "") {
  return isAmazonHostname(getHostname(url));
}

export function getPathname(url = "") {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function detectMode({ text = "", url = "" } = {}) {
  for (const hint of EXPLICIT_HINTS) {
    if (hint.pattern.test(text)) {
      return { mode: hint.mode, reason: "explicit-mode-hint" };
    }
  }

  const trimmedText = String(text).trim();
  if (/^[A-Z0-9]{10}$/i.test(trimmedText)) {
    return { mode: "amzlisting", reason: "amazon-asin" };
  }

  const hostname = getHostname(url);
  if (hostname === "members.helium10.com") {
    return { mode: "amzh10", reason: "helium10-domain" };
  }

  const pathname = getPathname(url);
  if (isAmazonHostname(hostname) && AMAZON_PDP_PATH_RE.test(pathname)) {
    return { mode: "amzlisting", reason: "amazon-domain" };
  }

  return { mode: "generic", reason: "fallback-generic" };
}
