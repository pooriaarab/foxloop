// Failure modes R1-R4 in docs/failure-modes.md: the tool registry and the
// argument check.
import { createFoxgate } from "foxgate";
import { describe, expect, it } from "vitest";
import { FoxloopError, checkArgs, defineTools, toolSpecs, type LoopTool } from "../src/index.js";

const tool = (over: Partial<LoopTool> = {}): LoopTool => ({
  name: "save_note",
  description: "Save a note.",
  parameters: { type: "object", properties: { text: { type: "string", maxLength: 20 } }, required: ["text"] },
  scope: "fill",
  domain: () => "notes.local",
  run: async () => ({ ok: true, summary: "saved" }),
  ...over,
});

const amount = (args: Record<string, unknown>) => ({ value: Number(args.total), currency: "USD" });

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxloopError ? error.code : `not a FoxloopError: ${String(error)}`;
  }
  return "no error";
};

describe("R1: tool names", () => {
  it("refuses a bad name, a second tool with the same name, and finish", () => {
    expect(code(() => defineTools([tool({ name: "save note" })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ name: "" })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool(), tool()]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ name: "finish" })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ run: undefined as never })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ domain: undefined as never })]))).toBe("bad-tool");
  });
});

describe("R2: schema keywords the validator does not check", () => {
  it("refuses oneOf, $ref and pattern, and names the keyword", () => {
    for (const keyword of ["oneOf", "$ref", "pattern"]) {
      const parameters = { type: "object", properties: { text: { type: "string", [keyword]: "x" } } };
      let message = "";
      try {
        defineTools([tool({ parameters })]);
      } catch (error) {
        message = error instanceof FoxloopError ? `${error.code}: ${error.message}` : String(error);
      }
      expect(message).toMatch(/^bad-schema: /);
      expect(message).toContain(keyword);
    }
  });

  it("refuses a top-level schema that is not an object type", () => {
    expect(code(() => defineTools([tool({ parameters: { type: "string" } })]))).toBe("bad-schema");
  });
});

describe("R3: scopes", () => {
  it("refuses a missing or unknown scope, and pay with no amount", () => {
    expect(code(() => defineTools([tool({ scope: undefined as never })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ scope: "admin" as never })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ scope: "pay" })]))).toBe("bad-tool");
    expect(code(() => defineTools([tool({ scope: "pay", amount: () => ({ value: 1, currency: "USD" }) })]))).toBe("no error");
  });

  it("gives foxgate the same scope and amount function", async () => {
    const checkout = tool({
      name: "checkout",
      scope: "pay",
      amount,
      parameters: { type: "object", properties: { total: { type: "integer" } }, required: ["total"] },
    });
    const specs = toolSpecs([tool(), checkout]);
    expect(specs).toEqual({ save_note: { scope: "fill" }, checkout: { scope: "pay", amount } });
    const { gate } = createFoxgate({ tools: specs });
    const wrong = await gate.check({ tool: "save_note", args: { text: "x" }, domain: "notes.local", scope: "submit" });
    expect(wrong.decision === "deny" && wrong.reason).toBe("wrong-scope");
  });
});

describe("R4: argument check", () => {
  const schema = {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 5 },
      count: { type: "integer", minimum: 1, maximum: 3 },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      nested: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      loose: { type: "object", additionalProperties: true },
    },
    required: ["text"],
  };

  it("accepts good arguments", () => {
    expect(checkArgs(schema, { text: "hi", count: 2, mode: "a", tags: ["x"], nested: { ok: true }, loose: { any: 1 } })).toBeNull();
  });

  it("names the path of the first error", () => {
    expect(checkArgs(schema, { count: 2 })).toMatch(/text.*required/);
    expect(checkArgs(schema, { text: 5 })).toMatch(/^text: /);
    expect(checkArgs(schema, { text: "too long" })).toMatch(/^text: /);
    expect(checkArgs(schema, { text: "" })).toMatch(/^text: /);
    expect(checkArgs(schema, { text: "hi", count: 1.5 })).toMatch(/^count: /);
    expect(checkArgs(schema, { text: "hi", count: 9 })).toMatch(/^count: /);
    expect(checkArgs(schema, { text: "hi", mode: "c" })).toMatch(/^mode: /);
    expect(checkArgs(schema, { text: "hi", tags: [1] })).toMatch(/^tags\[0\]: /);
    expect(checkArgs(schema, { text: "hi", tags: ["a", "b", "c"] })).toMatch(/^tags: /);
    expect(checkArgs(schema, { text: "hi", nested: {} })).toMatch(/nested\.ok.*required/);
  });

  it("refuses arguments the schema does not name, unless it allows them", () => {
    expect(checkArgs(schema, { text: "hi", scope: "read" })).toMatch(/scope.*not allowed/);
    expect(checkArgs(schema, { text: "hi", nested: { ok: true, amount: 1 } })).toMatch(/nested\.amount.*not allowed/);
  });

  it("refuses a value that is not an object", () => {
    for (const value of [null, [], "text", 3]) expect(checkArgs(schema, value)).not.toBeNull();
  });
});
