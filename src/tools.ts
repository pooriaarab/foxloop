import type { Scope, ToolSpec } from "foxgate";
import { FoxloopError } from "./errors.js";
import { assertSchema } from "./schema.js";
import type { LoopTool } from "./types.js";

/** The tool the model calls to say it is done. No host tool may take this name. */
export const FINISH = "finish";
const SCOPES: readonly Scope[] = ["read", "fill", "submit", "pay"];
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Checks every tool and returns them by name. Throws FoxloopError `bad-tool`
 * or `bad-schema` (docs/failure-modes.md R1-R3).
 */
export function defineTools(tools: readonly LoopTool[]): ReadonlyMap<string, LoopTool> {
  if (!Array.isArray(tools)) throw new FoxloopError("bad-tool", "tools must be an array");
  const byName = new Map<string, LoopTool>();
  for (const tool of tools) {
    const bad = (why: string): never => {
      throw new FoxloopError("bad-tool", `tool ${JSON.stringify(tool?.name)}: ${why}`);
    };
    if (typeof tool?.name !== "string" || !NAME.test(tool.name)) bad("the name must be 1-64 letters, digits, _ or -");
    if (tool.name === FINISH) bad(`"${FINISH}" is reserved for the loop`);
    if (byName.has(tool.name)) bad("another tool has this name");
    if (typeof tool.description !== "string") bad("needs a description");
    if (!SCOPES.includes(tool.scope)) bad(`the scope must be one of ${SCOPES.join(", ")}`);
    if (tool.scope === "pay" && typeof tool.amount !== "function") bad("a pay tool needs an amount function");
    if (tool.amount !== undefined && typeof tool.amount !== "function") bad("amount must be a function");
    if (typeof tool.domain !== "function") bad("needs a domain function");
    if (typeof tool.run !== "function") bad("needs a run function");
    assertSchema(tool.parameters, `${tool.name}.parameters`);
    if (tool.parameters.type !== "object") throw new FoxloopError("bad-schema", `${tool.name}.parameters: the type must be "object"`);
    byName.set(tool.name, tool);
  }
  return byName;
}

/**
 * The foxgate tool registry for these tools: the same scope and amount
 * function. Pass it to `createFoxgate({ tools })`, so the gate and the loop
 * agree on each tool.
 */
export function toolSpecs(tools: readonly LoopTool[]): Record<string, ToolSpec> {
  const specs: Record<string, ToolSpec> = {};
  for (const tool of defineTools(tools).values()) {
    specs[tool.name] = tool.amount ? { scope: tool.scope, amount: tool.amount } : { scope: tool.scope };
  }
  return specs;
}
