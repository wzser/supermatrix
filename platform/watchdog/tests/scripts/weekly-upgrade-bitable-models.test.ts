import { describe, expect, it } from "vitest";
import {
  MODEL_ENUM_FIELDS,
  parseModelEnumAdditions,
  planModelEnumSync,
  syncModelEnumAdditions,
  type LarkCommandRunner,
  type ModelEnumFieldDefinition,
} from "../../src/scripts/_weekly-upgrade-bitable-models.js";

function option(name: string, hue = "Blue") {
  return { name, hue, lightness: "Lighter" };
}

function fakeLarkRunner(input?: {
  failFieldId?: string;
}): {
  run: LarkCommandRunner;
  fields: Map<string, ModelEnumFieldDefinition>;
  updateCalls: string[];
} {
  const fields = new Map(MODEL_ENUM_FIELDS.map(({ id, name }, index) => [
    id,
    {
      id,
      name,
      type: "select" as const,
      multiple: false,
      description: `description-${index}`,
      options: [
        ...(name === "子model" ? [option("跟随主session", "Orange")] : []),
        option("default", "Yellow"),
        option("claude-opus-4-8", "Green"),
      ],
    },
  ]));
  const updateCalls: string[] = [];
  const valueAfter = (args: string[], flag: string): string => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
    return args[index + 1]!;
  };
  const json = (value: unknown) => ({
    status: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  });

  const run: LarkCommandRunner = (_bin, args) => {
    if (args[0] === "wiki" && args[1] === "+node-get") {
      return json({
        ok: true,
        identity: "user",
        data: {
          obj_type: "bitable",
          obj_token: "base_token",
        },
      });
    }
    if (args[0] === "base" && args[1] === "+field-get") {
      const fieldId = valueAfter(args, "--field-id");
      const field = fields.get(fieldId);
      if (!field) return { status: 1, stdout: "", stderr: "field missing" };
      return json({ ok: true, identity: "user", data: { field } });
    }
    if (args[0] === "base" && args[1] === "+field-update") {
      const fieldId = valueAfter(args, "--field-id");
      updateCalls.push(fieldId);
      if (input?.failFieldId === fieldId) {
        return { status: 1, stdout: "", stderr: "simulated write failure" };
      }
      const current = fields.get(fieldId);
      if (!current) return { status: 1, stdout: "", stderr: "field missing" };
      const body = JSON.parse(valueAfter(args, "--json")) as Omit<ModelEnumFieldDefinition, "id">;
      fields.set(fieldId, { id: fieldId, ...body });
      return json({
        ok: true,
        identity: "user",
        data: { field: fields.get(fieldId), updated: true },
      });
    }
    return { status: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
  };

  return { run, fields, updateCalls };
}

describe("weekly CLI model enum sync", () => {
  it("accepts only a standalone canonical model addition marker", () => {
    expect(parseModelEnumAdditions(`
## Auto-fixed
- updated model aliases (commit: abc1234 in SuperMatrix)

MODEL_ENUM_ADDITIONS: ["claude-opus-5", "gpt-5.7-sol", "claude-opus-5"]
MODEL_AUDIT_RESOLUTION: adjusted
`)).toEqual({
      status: "valid",
      models: ["claude-opus-5", "gpt-5.7-sol"],
    });

    expect(parseModelEnumAdditions("MODEL_ENUM_ADDITIONS: []")).toEqual({
      status: "valid",
      models: [],
    });
    expect(parseModelEnumAdditions("MODEL_ENUM_ADDITIONS: [\"opus\"]")).toMatchObject({
      status: "invalid",
    });
    expect(parseModelEnumAdditions("review omitted marker")).toEqual({
      status: "invalid",
      reason: "root review omitted MODEL_ENUM_ADDITIONS",
    });
  });

  it("runs only for the new pending contract after root accepted the model audit", () => {
    expect(planModelEnumSync({
      version: 1,
      auditStatus: "accepted",
      rootReview: 'MODEL_ENUM_ADDITIONS: ["claude-opus-5"]',
    })).toEqual({
      status: "ready",
      models: ["claude-opus-5"],
    });
    expect(planModelEnumSync({
      version: 1,
      auditStatus: "blocked",
      rootReview: 'MODEL_ENUM_ADDITIONS: ["claude-opus-5"]',
    })).toEqual({
      status: "skipped",
      reason: "model audit resolution is blocked",
    });
    expect(planModelEnumSync({
      version: 1,
      auditStatus: "accepted",
      rootReview: "review omitted marker",
    })).toEqual({
      status: "invalid",
      reason: "root review omitted MODEL_ENUM_ADDITIONS",
    });
    expect(planModelEnumSync({
      auditStatus: "accepted",
      rootReview: 'MODEL_ENUM_ADDITIONS: ["claude-opus-5"]',
    })).toEqual({ status: "legacy-skip" });
  });

  it("appends verified model ids to all three fields without changing existing options", () => {
    const fake = fakeLarkRunner();

    const result = syncModelEnumAdditions({
      larkBin: "/fake/lark-cli",
      models: ["claude-opus-5", "claude-sonnet-5"],
      run: fake.run,
    });

    expect(result).toMatchObject({
      status: "updated",
      requested: ["claude-opus-5", "claude-sonnet-5"],
      added: ["claude-opus-5", "claude-sonnet-5"],
    });
    expect(fake.updateCalls).toEqual(MODEL_ENUM_FIELDS.map(({ id }) => id));
    for (const [index, target] of MODEL_ENUM_FIELDS.entries()) {
      const field = fake.fields.get(target.id)!;
      expect(field.description).toBe(`description-${index}`);
      expect(field.multiple).toBe(false);
      expect(field.options.map(({ name }) => name)).toEqual([
        ...(target.name === "子model" ? ["跟随主session"] : []),
        "default",
        "claude-opus-4-8",
        "claude-opus-5",
        "claude-sonnet-5",
      ]);
    }
  });

  it("is idempotent and performs no field PUT when every model already exists", () => {
    const fake = fakeLarkRunner();
    syncModelEnumAdditions({
      larkBin: "/fake/lark-cli",
      models: ["claude-opus-5"],
      run: fake.run,
    });
    const writesAfterFirstRun = fake.updateCalls.length;

    const second = syncModelEnumAdditions({
      larkBin: "/fake/lark-cli",
      models: ["claude-opus-5"],
      run: fake.run,
    });

    expect(second).toMatchObject({
      status: "unchanged",
      requested: ["claude-opus-5"],
      added: [],
    });
    expect(fake.updateCalls).toHaveLength(writesAfterFirstRun);
  });

  it("throws on a field write failure instead of returning a success receipt", () => {
    const fake = fakeLarkRunner({ failFieldId: MODEL_ENUM_FIELDS[1]!.id });

    expect(() => syncModelEnumAdditions({
      larkBin: "/fake/lark-cli",
      models: ["claude-opus-5"],
      run: fake.run,
    })).toThrow(/主model当前.*simulated write failure/);
  });
});
