import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectClaudeVersionFile,
  patchClaudeMarkerText,
} from "../../src/scripts/check-claude-marker.js";

const oldP8d = String.raw`function P8d(e,t){if(!e&&!t)return"'";if(e&&!t)return"\u2019";if(!e&&t)return"\u02BC";return"\u02B9"}`;
const oldRYi = String.raw`function RYi(e){let t=D8d(),n=P8d(t?.known??!1,t?.labKw??!1),r=t?.cnTZ?e.replaceAll("-","/"):e;return` + "`Today${n}s date is ${r}.`}";

function writeFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "watchdog-claude-marker-"));
  const file = join(dir, "claude-version");
  writeFileSync(file, contents);
  return file;
}

describe("claude marker regression check", () => {
  it("detects the known old hidden marker implementation", () => {
    const file = writeFixture(`D8d Asia/Shanghai Asia/Urumqi ${oldP8d} ${oldRYi}`);

    expect(inspectClaudeVersionFile(file)).toMatchObject({
      status: "needs_repair",
      hasOldP8d: true,
      hasOldRYi: true,
      hasBadApostropheReturns: true,
      hasDateSlashReplace: true,
    });
  });

  it("patches the known old marker fragments without changing byte length", () => {
    const before = `prefix D8d Asia/Shanghai Asia/Urumqi ${oldP8d} ${oldRYi} suffix`;
    const after = patchClaudeMarkerText(before);
    const file = writeFixture(after);

    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    expect(inspectClaudeVersionFile(file)).toMatchObject({
      status: "patched",
      hasPatchedP8d: true,
      hasPatchedRYi: true,
      hasBadApostropheReturns: false,
      hasDateSlashReplace: false,
    });
  });
});
