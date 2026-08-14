import {
  createRepairWorktree,
  listRepairWorktreeChangedFiles
} from "./repair-worktree.mjs";

function requireFunction(value, fieldName) {
  if (typeof value !== "function") {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function normalizeMaxHypotheses(value) {
  if (value === undefined) {
    return 10;
  }

  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error(`Invalid maxHypotheses: ${value}`);
  }

  return count;
}

function toFailureValidation(error) {
  return {
    ok: false,
    summary: error instanceof Error ? error.message : String(error)
  };
}

function normalizePath(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").trim();
}

function uniqueChangedFiles(...groups) {
  const files = [];
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const entry of group) {
      const normalized = normalizePath(entry);
      if (normalized && !files.includes(normalized)) {
        files.push(normalized);
      }
    }
  }

  return files;
}

function buildAllowedPathPrefixes(incident, extraAllowedPathPrefixes = []) {
  const prefixes = [
    `scripts/packs/${incident.packName}/`,
    `tests/packs/${incident.packName}`
  ];
  for (const prefix of extraAllowedPathPrefixes) {
    const normalized = normalizePath(prefix);
    if (normalized) {
      prefixes.push(normalized.endsWith("/") ? normalized : `${normalized}/`);
    }
  }
  return prefixes;
}

function evaluateMergeReadiness({
  incident,
  validation,
  repairAttempt,
  changedFiles,
  extraAllowedPathPrefixes = []
}) {
  const reasons = [];
  const hypothesis = typeof repairAttempt?.hypothesis === "string" ? repairAttempt.hypothesis.trim() : "";
  const tests = Array.isArray(validation?.tests) ? validation.tests : [];
  const smoke = Array.isArray(validation?.smoke) ? validation.smoke : [];
  const allowedPathPrefixes = buildAllowedPathPrefixes(incident, extraAllowedPathPrefixes);

  if (validation?.ok !== true) {
    reasons.push("Validation must pass before merge");
  }

  if (tests.length === 0) {
    reasons.push("Relevant tests are required before merge");
  }

  if (smoke.length === 0) {
    reasons.push("At least one smoke run is required before merge");
  }

  if (hypothesis === "") {
    reasons.push("A non-empty repair hypothesis is required before merge");
  }

  if (changedFiles.length === 0) {
    reasons.push("Changed files are required before merge");
  } else {
    const disallowedFiles = changedFiles.filter((filePath) => {
      if (filePath.startsWith("../") || filePath.startsWith("/")) {
        return true;
      }

      return !allowedPathPrefixes.some((prefix) => filePath.startsWith(prefix));
    });

    if (disallowedFiles.length > 0) {
      reasons.push(`Changed files outside the allowed scope: ${disallowedFiles.join(", ")}`);
    }
  }

  return {
    ready: reasons.length === 0,
    changedFiles,
    reasons
  };
}

export function runPackValidation({ packName, smokeRoot = "/tmp/web-access-smoke" } = {}) {
  const normalizedPackName = normalizePath(packName);
  const commands = {
    amzlisting: [
      ["node", ["--test", "tests/packs/amzlisting.test.mjs", "tests/packs/amzlisting-batch.test.mjs"]],
      [
        "node",
        [
          "-e",
          [
            "const { spawnSync } = require('node:child_process');",
            "const result = spawnSync(process.execPath, ['scripts/packs/amzlisting/capture_batch.mjs','--asin','ASIN_REDACTED','--profile','default','--captures-root', process.argv[1], '--compact'], { encoding: 'utf8' });",
            "if (result.stdout) process.stdout.write(result.stdout);",
            "if (result.stderr) process.stderr.write(result.stderr);",
            "if (result.status !== 0) process.exit(result.status || 1);",
            "const manifest = JSON.parse(result.stdout || '{}');",
            "const hasTerminalItem = Array.isArray(manifest.items) && manifest.items.some((item) => ['error', 'blocked'].includes(String(item?.status || '').toLowerCase()));",
            "if (hasTerminalItem) {",
            "  console.error('amzlisting smoke manifest contains terminal item status');",
            "  process.exit(1);",
            "}"
          ].join(" "),
          smokeRoot
        ]
      ]
    ],
    amzh10: [
      ["node", ["--test", "tests/packs/amzh10.test.mjs"]]
    ]
  };

  return commands[normalizedPackName] || [];
}

export async function runRepairOrchestrator({
  incident,
  repoRoot = process.cwd(),
  maxHypotheses = 10,
  autoMerge = true,
  extraAllowedPathPrefixes = [],
  createWorktreeImpl = createRepairWorktree,
  listChangedFilesImpl = listRepairWorktreeChangedFiles,
  spawnRepairAgentImpl,
  runValidationImpl,
  mergeRepairBranchImpl = async () => {}
} = {}) {
  if (!incident || typeof incident !== "object") {
    throw new Error("incident is required");
  }

  requireFunction(createWorktreeImpl, "createWorktreeImpl");
  requireFunction(listChangedFilesImpl, "listChangedFilesImpl");
  requireFunction(spawnRepairAgentImpl, "spawnRepairAgentImpl");
  requireFunction(runValidationImpl, "runValidationImpl");
  requireFunction(mergeRepairBranchImpl, "mergeRepairBranchImpl");

  const attempts = [];
  const hypothesisBudget = normalizeMaxHypotheses(maxHypotheses);
  let lastWorktree = null;

  for (let attempt = 1; attempt <= hypothesisBudget; attempt += 1) {
    const worktree = await createWorktreeImpl({
      repoRoot,
      packName: incident.packName,
      incidentId: incident.id,
      attempt
    });
    lastWorktree = worktree;

    let repairAttempt;

    try {
      repairAttempt = await spawnRepairAgentImpl({
        incident,
        attempt,
        worktree
      });
    } catch (error) {
      attempts.push({
        attempt,
        validation: toFailureValidation(error)
      });
      continue;
    }

    let validation;
    try {
      validation = await runValidationImpl({
        incident,
        attempt,
        worktree,
        repairAttempt
      });
    } catch (error) {
      validation = toFailureValidation(error);
    }

    let changedFiles = [];
    try {
      changedFiles = uniqueChangedFiles(
        await listChangedFilesImpl({
          incident,
          attempt,
          worktree,
          repairAttempt,
          validation
        })
      );
    } catch (error) {
      changedFiles = [];
      validation = {
        ...validation,
        changedFilesError: error instanceof Error ? error.message : String(error)
      };
    }

    const mergeReadiness = evaluateMergeReadiness({
      incident,
      validation,
      repairAttempt,
      changedFiles,
      extraAllowedPathPrefixes
    });
    validation = {
      ...validation,
      mergeReadiness
    };

    const attemptSummary = {
      attempt,
      ...repairAttempt,
      validation
    };
    attempts.push(attemptSummary);

    if (mergeReadiness.ready !== true) {
      continue;
    }

    if (autoMerge) {
      await mergeRepairBranchImpl({
        incident,
        attempt,
        branchName: worktree.branchName,
        worktree,
        repairAttempt,
        validation
      });
      return {
        status: "merged",
        attempt,
        branchName: worktree.branchName,
        validation
      };
    }

    return {
      status: "validated",
      attempt,
      branchName: worktree.branchName,
      validation
    };
  }

  return {
    status: "failed",
    attempt: attempts.length,
    branchName: lastWorktree?.branchName ?? "",
    failureSummary: {
      attempts
    }
  };
}
