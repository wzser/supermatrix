import path from "node:path";
import { runMatrixInit } from "./init/run.ts";

type InitCliOptions = {
  skipAuth: boolean;
  skipRootGroup: boolean;
  skipSelfCheck: boolean;
};

function parseArgs(argv: string[]): InitCliOptions {
  return {
    skipAuth: argv.includes("--skip-auth"),
    skipRootGroup: argv.includes("--skip-root-group"),
    skipSelfCheck: argv.includes("--skip-self-check"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const packageRoot = process.cwd();
  const repoRoot = path.resolve(packageRoot, "..");
  await runMatrixInit({
    repoRoot,
    packageRoot,
    skipAuth: options.skipAuth,
    skipRootGroup: options.skipRootGroup,
    skipSelfCheck: options.skipSelfCheck,
  });
}

main().catch((err) => {
  console.error("[init] fatal:", err);
  process.exit(1);
});
