#!/usr/bin/env tsx
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type Layer = "domain" | "ports" | "adapters" | "app" | "cli" | "unknown";

const ALLOWED: Record<Layer, Layer[]> = {
  domain: ["domain"],
  ports: ["ports", "domain"],
  adapters: ["adapters", "ports", "domain"],
  app: ["app", "ports", "domain"],
  cli: ["cli", "app", "adapters", "ports", "domain"],
  unknown: ["domain", "ports", "adapters", "app", "cli", "unknown"],
};

export function classifyImport(path: string): Layer {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.includes("/src/domain/") || normalized.startsWith("src/domain/")) return "domain";
  if (normalized.includes("/src/ports/") || normalized.startsWith("src/ports/")) return "ports";
  if (normalized.includes("/src/adapters/") || normalized.startsWith("src/adapters/")) return "adapters";
  if (normalized.includes("/src/app/") || normalized.startsWith("src/app/")) return "app";
  if (normalized.includes("/src/cli/") || normalized.startsWith("src/cli/")) return "cli";
  return "unknown";
}

export function isViolation(from: Layer, to: Layer): boolean {
  if (from === "unknown" || to === "unknown") return false;
  return !ALLOWED[from].includes(to);
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walk(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /from\s+["']([^"']+)["']/g;

async function main() {
  const repoRoot = resolve(process.cwd());
  const srcRoot = join(repoRoot, "src");
  const files = await walk(srcRoot);
  const violations: string[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const fromLayer = classifyImport(relative(repoRoot, file));
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const target = resolve(file, "..", spec);
      const toLayer = classifyImport(relative(repoRoot, target));
      if (isViolation(fromLayer, toLayer)) {
        violations.push(
          `${relative(repoRoot, file)} (${fromLayer}) → ${spec} (${toLayer})`
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error("Dependency direction violations:\n" + violations.map((v) => "  " + v).join("\n"));
    process.exit(1);
  }
  console.log("check-deps: OK");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
