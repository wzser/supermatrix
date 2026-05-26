import { describe, expect, it } from "vitest";
import {
  normalizeRegistrationResult,
  requiredLarkScopes,
} from "../../src/cli/init/personalAgent.ts";

describe("PersonalAgent init helpers", () => {
  it("normalizes the Lark SDK registration result into Super Matrix fields", () => {
    const result = normalizeRegistrationResult({
      client_id: "cli_created",
      client_secret: "created-secret",
      user_info: {
        tenant_brand: "lark",
        open_id: "ou_scanner",
      },
    });

    expect(result).toEqual({
      appId: "cli_created",
      appSecret: "created-secret",
      tenant: "lark",
      operatorOpenId: "ou_scanner",
    });
  });

  it("requests the scopes needed for root console and session group operations", () => {
    expect(requiredLarkScopes()).toContain("im:message");
    expect(requiredLarkScopes()).toContain("im:chat:create_by_user");
    expect(requiredLarkScopes()).toContain("im:chat.members:write_only");
  });
});
