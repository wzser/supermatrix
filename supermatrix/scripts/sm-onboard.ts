#!/usr/bin/env tsx
import { parseOnboardingArgs, renderHelp, runOnboarding } from "../src/cli/onboardingV1.ts";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(renderHelp());
} else {
  runOnboarding(parseOnboardingArgs(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
