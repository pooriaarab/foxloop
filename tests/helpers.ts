// Shared parts for the loop tests: a real foxgate, a note tool, and a way to
// collect every event of a run.
import { createFoxgate, type Gate, type GrantInput } from "foxgate";
import type { LoopEvent, LoopTool, ToolOutput } from "../src/index.js";

export const DOMAIN = "notes.local";

/** A fill tool that saves text. Each run is recorded in `runs`. */
export function noteTool(output: (args: Record<string, unknown>) => ToolOutput | Promise<ToolOutput> = () => ({ ok: true, summary: "saved" })) {
  const runs: Record<string, unknown>[] = [];
  const tool: LoopTool = {
    name: "save_note",
    description: "Save a note.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    scope: "fill",
    domain: () => DOMAIN,
    run: async (args) => {
      runs.push(args);
      return output(args);
    },
  };
  return { tool, runs };
}

/** A real foxgate for the tools, with grants, that counts its calls. */
export async function gateFor(tools: LoopTool[], grants: GrantInput[] = [{ scope: "fill", domains: [DOMAIN] }]) {
  const specs: Record<string, { scope: LoopTool["scope"] }> = {};
  for (const tool of tools) specs[tool.name] = { scope: tool.scope };
  const { gate, host } = createFoxgate({ tools: specs });
  for (const grant of grants) await host.addGrant(grant);
  const seen: string[] = [];
  const counted: Gate = {
    check: (action) => {
      seen.push(`check:${action.tool}`);
      return gate.check(action);
    },
    redeem: (token, action) => {
      seen.push(`redeem:${action.tool}`);
      return gate.redeem(token, action);
    },
  };
  return { gate: counted, host, seen };
}

export async function collect(events: AsyncIterable<LoopEvent>): Promise<LoopEvent[]> {
  const all: LoopEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

export const last = (events: LoopEvent[]) => events.at(-1);
export const ofType = <T extends LoopEvent["type"]>(events: LoopEvent[], type: T) =>
  events.filter((e): e is Extract<LoopEvent, { type: T }> => e.type === type);
