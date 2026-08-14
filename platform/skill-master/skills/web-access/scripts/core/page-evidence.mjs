import fs from "node:fs/promises";
import path from "node:path";

function sanitizeSegment(value, fallback = "evidence") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

async function captureScreenshot(connection) {
  const result = await connection.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true
  });
  return Buffer.from(String(result?.data || ""), "base64");
}

async function captureHtml(connection) {
  const result = await connection.send("Runtime.evaluate", {
    expression: "(() => document.documentElement?.outerHTML || document.body?.outerHTML || '')()",
    awaitPromise: true,
    returnByValue: true
  });
  if (result?.exceptionDetails) {
    throw new Error("Runtime.evaluate failed");
  }
  return String(result?.result?.value || "");
}

export async function capturePageEvidence({
  connection,
  evidenceRoot,
  packName,
  runId,
  label,
  pageState = {},
  now = () => new Date(),
  mkdirImpl = fs.mkdir,
  writeFileImpl = fs.writeFile
} = {}) {
  if (!connection || typeof connection.send !== "function") {
    throw new Error("connection.send is required");
  }

  const capturedAt = now().toISOString();
  const dateBucket = capturedAt.slice(0, 10);
  const safePackName = sanitizeSegment(packName, "pack");
  const safeRunId = sanitizeSegment(runId, "run");
  const safeLabel = sanitizeSegment(label, "evidence");
  const evidenceDir = path.join(
    String(evidenceRoot || path.join(process.cwd(), "artifacts", "web-access")),
    safePackName,
    dateBucket,
    safeRunId
  );
  const screenshotPath = path.join(evidenceDir, `${safeLabel}.png`);
  const htmlPath = path.join(evidenceDir, `${safeLabel}.html`);
  const summaryPath = path.join(evidenceDir, `${safeLabel}.json`);
  const captureErrors = {};
  let writtenScreenshotPath = "";
  let writtenHtmlPath = "";

  await mkdirImpl(evidenceDir, { recursive: true });

  try {
    const screenshotBytes = await captureScreenshot(connection);
    await writeFileImpl(screenshotPath, screenshotBytes);
    writtenScreenshotPath = screenshotPath;
  } catch (error) {
    captureErrors.screenshot = String(error?.message || error);
  }

  try {
    const html = await captureHtml(connection);
    await writeFileImpl(htmlPath, html, "utf8");
    writtenHtmlPath = htmlPath;
  } catch (error) {
    captureErrors.html = String(error?.message || error);
  }

  const summary = {
    label: safeLabel,
    capturedAt,
    evidenceDir,
    screenshotPath: writtenScreenshotPath,
    htmlPath: writtenHtmlPath,
    pageState,
    captureErrors
  };
  await writeFileImpl(summaryPath, JSON.stringify(summary, null, 2));

  return {
    evidenceDir,
    screenshotPath: writtenScreenshotPath,
    htmlPath: writtenHtmlPath,
    summaryPath,
    capturedAt,
    label: safeLabel,
    pageState,
    captureErrors
  };
}
