import { describe, expect, it } from "vitest";
import {
  SECRET_REDACTION_MARKER_PREFIX,
  findSecretMatches,
  redactSecretsInText,
} from "../../src/scripts/secret-redaction.js";

const OPENAI_KEY = "sk-proj-TEST_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const ANTHROPIC_KEY = "sk-ant-api03-TEST_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const GITHUB_PAT = "github_pat_EXAMPLE_abcdefghijklmnopqrstuvwxyz1234567890ABCDE";
const GENERIC_KEY = "hf_TEST_abCDef1234567890abcdef1234567890";

describe("secret redaction detector", () => {
  it("detects high-confidence provider keys and labelled generic secrets", () => {
    const text = [
      `OPENAI_API_KEY=${OPENAI_KEY}`,
      `anthropic=${ANTHROPIC_KEY}`,
      `aws_access_key_id=${AWS_ACCESS_KEY_ID}`,
      `aws_secret_access_key=${AWS_SECRET_ACCESS_KEY}`,
      `token: ${GITHUB_PAT}`,
      `"api_key": "${GENERIC_KEY}"`,
    ].join("\n");

    const matches = findSecretMatches(text);

    expect(matches.map((m) => m.ruleId)).toEqual([
      "openai_api_key",
      "anthropic_api_key",
      "aws_access_key_id",
      "aws_secret_access_key",
      "github_token",
      "generic_labelled_secret",
    ]);
    expect(matches.map((m) => m.value)).toEqual([
      OPENAI_KEY,
      ANTHROPIC_KEY,
      AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY,
      GITHUB_PAT,
      GENERIC_KEY,
    ]);
  });

  it("redacts only the secret values and never emits the original secret in output", () => {
    const input = `keep label OPENAI_API_KEY=${OPENAI_KEY} after`;

    const result = redactSecretsInText(input);

    expect(result.changed).toBe(true);
    expect(result.redactedText).toContain("OPENAI_API_KEY=");
    expect(result.redactedText).toContain(SECRET_REDACTION_MARKER_PREFIX);
    expect(result.redactedText).not.toContain(OPENAI_KEY);
  });

  it("does not mistake SuperMatrix ids, UUIDs, hashes, dates, or existing markers for secrets", () => {
    const text = [
      "first-principle | Opus 4.8 · done | mr_a719e551",
      "sess_a894c371 oc_REDACTEDCHATID",
      "comm_f78ba9d8_1780281095238 child_codexroot_8ba9d8",
      "19a0cee177a8f71d39590ff75bc60c590b8c7c16",
      "c54be11d-c279-4e78-bcbd-7dcb6a14831b",
      "2026-06-01T12:23:24+08:00",
      "[REDACTED_SECRET:abcdef123456]",
    ].join("\n");

    expect(findSecretMatches(text)).toEqual([]);
  });
});
