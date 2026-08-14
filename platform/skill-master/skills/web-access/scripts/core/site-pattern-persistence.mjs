import fs from "node:fs/promises";
import path from "node:path";

function normalizeEntry(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeEntries(values = []) {
  const seen = new Set();
  const entries = [];

  for (const value of values) {
    const normalized = normalizeEntry(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }

  return entries;
}

function parseAliases(frontmatter = "") {
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(/^\s*aliases:\s*\[(.*)\]\s*$/);
    if (inline) {
      return normalizeEntries(
        inline[1]
          .split(",")
          .map((value) => value.trim().replace(/^["']|["']$/g, ""))
      );
    }

    if (!/^\s*aliases:\s*$/.test(line)) {
      continue;
    }

    const aliases = [];
    for (let aliasIndex = index + 1; aliasIndex < lines.length; aliasIndex += 1) {
      const aliasLine = lines[aliasIndex];
      if (/^\s*-\s+/.test(aliasLine)) {
        aliases.push(aliasLine.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
        continue;
      }
      if (aliasLine.trim() === "") {
        continue;
      }
      break;
    }

    return normalizeEntries(aliases);
  }

  return [];
}

function parseMarkdownSections(raw = "") {
  const matches = [...raw.matchAll(/^## (.+)\s*$/gm)];
  return matches.map((match, index) => {
    const heading = match[1].trim();
    const headingLineEnd = match.index + match[0].length;
    const nextHeadingStart = index + 1 < matches.length ? matches[index + 1].index : raw.length;
    const body = raw
      .slice(headingLineEnd, nextHeadingStart)
      .replace(/^\r?\n+/, "")
      .replace(/\s+$/, "");

    return { heading, body };
  });
}

function parseSection(raw = "", heading) {
  const section = parseMarkdownSections(raw).find((entry) => entry.heading === heading);
  if (!section) return [];

  const entries = [];
  let prose = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    entries.push(prose.join(" "));
    prose = [];
  };

  for (const line of section.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushProse();
      continue;
    }

    if (trimmed.startsWith("- ")) {
      flushProse();
      entries.push(trimmed.replace(/^-\s*/, ""));
      continue;
    }

    prose.push(trimmed);
  }

  flushProse();

  return normalizeEntries(entries);
}

function parseExtraSections(raw = "") {
  const known = new Set(["Platform Traits", "Valid Patterns", "Known Traps"]);
  return parseMarkdownSections(raw)
    .filter(({ heading }) => !known.has(heading))
    .map(({ heading, body }) => ({ heading, body }));
}

export function parseSitePatternMarkdown(raw = "") {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter = fm ? fm[1] : "";
  const domain = frontmatter.match(/^\s*domain:\s*(.+)\s*$/m)?.[1]?.trim() || "";
  const updated = frontmatter.match(/^\s*updated:\s*(.+)\s*$/m)?.[1]?.trim() || "";

  return {
    domain,
    aliases: parseAliases(frontmatter),
    updated,
    platformTraits: parseSection(raw, "Platform Traits"),
    validPatterns: parseSection(raw, "Valid Patterns"),
    knownTraps: parseSection(raw, "Known Traps"),
    extraSections: parseExtraSections(raw)
  };
}

export function formatSitePatternMarkdown({
  domain,
  aliases = [],
  updated,
  platformTraits = [],
  validPatterns = [],
  knownTraps = [],
  extraSections = []
}) {
  const aliasList = normalizeEntries(aliases).join(", ");
  const block = (heading, values) =>
    `## ${heading}\n\n${normalizeEntries(values).map((value) => `- ${value}`).join("\n")}\n`;
  const extras = extraSections
    .map(({ heading, body = "" }) => `## ${heading}\n\n${String(body).replace(/\s+$/, "")}\n`)
    .join("\n");

  return `---\ndomain: ${domain}\naliases: [${aliasList}]\nupdated: ${updated}\n---\n\n${block("Platform Traits", platformTraits)}\n${block("Valid Patterns", validPatterns)}\n${block("Known Traps", knownTraps)}${extras ? `\n${extras}` : "\n"}`;
}

export async function mergeSitePatternObservation({
  repoRoot = process.cwd(),
  domain,
  aliases = [],
  observation = {}
}) {
  const targetPath = path.join(repoRoot, "references", "site-patterns", `${domain}.md`);
  let existing = {
    domain,
    aliases: [],
    updated: "",
    platformTraits: [],
    validPatterns: [],
    knownTraps: [],
    extraSections: []
  };

  try {
    existing = parseSitePatternMarkdown(await fs.readFile(targetPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const merged = {
    domain,
    aliases: normalizeEntries([...existing.aliases, ...aliases]),
    updated: observation.updated,
    platformTraits: normalizeEntries([...existing.platformTraits, ...(observation.platformTraits || [])]),
    validPatterns: normalizeEntries([...existing.validPatterns, ...(observation.validPatterns || [])]),
    knownTraps: normalizeEntries([...existing.knownTraps, ...(observation.knownTraps || [])]),
    extraSections: existing.extraSections
  };

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, formatSitePatternMarkdown(merged), "utf8");

  return {
    absolutePath: targetPath,
    relativePath: path.relative(repoRoot, targetPath)
  };
}
