#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchSitePatterns } from "./site-patterns.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const query = process.argv.slice(2).join(" ").trim();
const dir = path.join(ROOT, "references", "site-patterns");

for (const match of matchSitePatterns({ query, dir })) {
  process.stdout.write(`--- 站点经验: ${match.domain} ---\n`);
  process.stdout.write(`${match.body}\n\n`);
}
