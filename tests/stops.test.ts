// Failure modes L7-L9 in docs/failure-modes.md: the budget and the abort
// signal stop a run, even when a tool or the model ignores the signal.
import { describe, expect, it } from "vitest";
import { createLoop, scriptedMind, type LoopTool } from "../src/index.js";
import { collect, gateFor, last, noteTool, ofType } from "./helpers.js";

const save = (text: string) => ({ calls: [{ name: "save_note", args: { text } }] });

describe("L7: budget", () => {
  it("stops before a model call when the tokens are used up", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const steps = [save("a"), save("b"), save("c")];
    const mind = scriptedMind(steps);
    const counted = { chat: async (...args: Parameters<typeof mind.chat>) => ({ ...(await mind.chat(...args)), usage: { inputTokens: 600, outputTokens: 100 } }) };
    const events = await collect(createLoop({ mind: counted, gate, tools: [note.tool], budget: { tokens: 1000 } }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "budget" });
    expect(mind.seen.length).toBe(2);
  });

  it("counts tokens from the text when the model gives no usage", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const mind = scriptedMind([save("a".repeat(8000)), save("b")]);
    const bare = { chat: async (...args: Parameters<typeof mind.chat>) => {
      const { usage: _usage, ...reply } = await mind.chat(...args);
      return reply;
    } };
    const events = await collect(createLoop({ mind: bare, gate, tools: [note.tool], budget: { tokens: 1500 } }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "budget" });
    expect(mind.seen.length).toBe(1);
  });

  it("stops before a tool call when the tool calls are used up", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const events = await collect(createLoop({ mind: scriptedMind([save("a"), save("b"), save("c")]), gate, tools: [note.tool], budget: { toolCalls: 2 } }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "budget" });
    expect(note.runs.length).toBe(2);
  });

  it("stops when the time is used up", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    let clock = 0;
    const slow = noteTool(() => {
      clock += 60_000;
      return { ok: true, summary: "saved" };
    });
    const events = await collect(createLoop({ mind: scriptedMind([save("a"), save("b")]), gate, tools: [slow.tool], budget: { ms: 30_000 }, now: () => clock }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "budget" });
    expect(slow.runs.length).toBe(1);
    expect(note.runs.length).toBe(0);
  });
});

describe("L8, L9: abort", () => {
  it("L8: aborts during a model call that ignores the signal, and runs no tool", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const controller = new AbortController();
    const mind = scriptedMind([() => new Promise(() => controller.abort())]);
    const events = await collect(createLoop({ mind, gate, tools: [note.tool] }).run("Save.", { signal: controller.signal }));
    expect(last(events)?.type).toBe("aborted");
    expect(note.runs).toEqual([]);
  });

  it("L8: an abort before the run starts runs nothing", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const mind = scriptedMind([save("a")]);
    const events = await collect(createLoop({ mind, gate, tools: [note.tool] }).run("Save.", { signal: AbortSignal.abort() }));
    expect(events.map((e) => e.type)).toEqual(["aborted"]);
    expect(mind.seen.length).toBe(0);
  });

  it("L9: aborts at once during a tool that ignores the signal, and drops the late result", async () => {
    const controller = new AbortController();
    let signalSeen: AbortSignal | undefined;
    const stuck: LoopTool = {
      ...noteTool().tool,
      run: (_args, ctx) => {
        signalSeen = ctx.signal;
        setTimeout(() => controller.abort(), 10);
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: "late" }), 5000));
      },
    };
    const { gate } = await gateFor([stuck]);
    const mind = scriptedMind([save("a"), save("b")]);
    const started = Date.now();
    const events = await collect(createLoop({ mind, gate, tools: [stuck] }).run("Save.", { signal: controller.signal }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(last(events)?.type).toBe("aborted");
    expect(ofType(events, "tool-result")).toEqual([]);
    expect(signalSeen?.aborted).toBe(true);
    expect(mind.seen.length).toBe(1);
  });
});

describe("L15, L16: late results and the budget before approval", () => {
  it("L15: logs a tool result that ends after the abort", async () => {
    const controller = new AbortController();
    const entries: { kind: string; data?: unknown }[] = [];
    const trail = { append: async (entry: { kind: string; data?: unknown }) => void entries.push(entry) };
    const slow: LoopTool = {
      ...noteTool().tool,
      run: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, summary: "clicked late" }), 100));
      },
    };
    const { gate } = await gateFor([slow]);
    const events = await collect(createLoop({ mind: scriptedMind([save("a")]), gate, tools: [slow], trail }).run("Save.", { signal: controller.signal }));
    expect(last(events)?.type).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(entries.map((e) => e.kind).slice(-2)).toEqual(["loop.aborted", "loop.late-result"]);
    expect(entries.at(-1)?.data).toMatchObject({ name: "save_note", ok: true, summary: "clicked late" });
  });

  it("L16: checks the tool call budget before it asks the human", async () => {
    const note = noteTool();
    const send: LoopTool = { ...noteTool().tool, name: "send_note", scope: "submit" };
    const { gate, host } = await gateFor([note.tool, send], [{ scope: "fill", domains: ["notes.local"] }, { scope: "submit", domains: ["notes.local"] }]);
    let asked = 0;
    const onApproval = async (request: { requestId: string }) => {
      asked++;
      return host.approve(request.requestId);
    };
    const mind = scriptedMind([save("a"), { calls: [{ name: "send_note", args: { text: "b" } }] }]);
    const events = await collect(createLoop({ mind, gate, tools: [note.tool, send], budget: { toolCalls: 1 }, onApproval }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "budget" });
    expect(asked).toBe(0);
    expect(ofType(events, "decision").length).toBe(1);
  });
});

