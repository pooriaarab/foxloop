// Failure modes S1-S7 in docs/failure-modes.md: `settle` ends the run
// without the model call that would only say "finish".
import { describe, expect, it } from "vitest";
import { LIMITS, createLoop, scriptedMind, type CheckResult, type ScriptReply, type LoopEvent, type LoopTool, type SettleInput, type ToolOutput } from "../src/index.js";
import { DOMAIN, collect, gateFor, last, ofType } from "./helpers.js";

const pass: CheckResult = { ok: true, checks: [{ part: "sent", ok: true, evidence: "sent" }] };
const fail: CheckResult = { ok: false, checks: [{ part: "sent", ok: false, evidence: "not sent" }] };
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function tool(name: string, output: () => ToolOutput = () => ({ ok: true, summary: `${name} ran`, check: pass })) {
  const runs: unknown[] = [];
  const t: LoopTool = {
    name, description: name, scope: "fill", parameters: { type: "object", properties: { text: { type: "string" } } }, domain: () => DOMAIN,
    run: async (args) => {
      runs.push(args);
      return output();
    },
  };
  return { tool: t, runs };
}

/** A model reply that takes `ms`, and records whether its signal aborted. */
function slow(reply: ScriptReply, ms: number, seen: { aborted?: boolean }) {
  return async (_messages: unknown, signal?: AbortSignal): Promise<ScriptReply> => {
    await new Promise<void>((done) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        seen.aborted = true;
        done();
      }, { once: true });
    });
    if (signal?.aborted) throw new Error("aborted");
    return reply;
  };
}

async function setup(steps: Parameters<typeof scriptedMind>[0], settle: (input: SettleInput) => Promise<string | undefined>, output?: () => ToolOutput) {
  const send = tool("send", output);
  const other = tool("other");
  const tools = [send.tool, other.tool];
  const { gate } = await gateFor(tools);
  const mind = scriptedMind(steps);
  const asked: SettleInput[] = [];
  const loop = createLoop({
    mind, gate, tools, settle: async (input) => {
      asked.push(input);
      return settle(input);
    },
  });
  return { loop, mind, send, other, asked };
}

const doneOf = (events: LoopEvent[]) => ofType(events, "done")[0];

describe("S2: settle ends the run without the last model call", () => {
  it("stops the model call, runs none of its tools, and ends done with settled", async () => {
    const seen: { aborted?: boolean } = {};
    const { loop, other, asked } = await setup([{ calls: [{ name: "send", args: { text: "hi" } }] }, slow({ calls: [{ name: "other", args: {} }] }, 300, seen)], async () => "Message sent to Sam");
    const events = await collect(loop.run("send hi"));
    expect(last(events)).toMatchObject({ type: "done", summary: "Message sent to Sam", settled: true });
    expect(ofType(events, "check")).toHaveLength(1);
    expect(seen.aborted).toBe(true);
    await wait(350);
    expect(other.runs).toHaveLength(0);
    expect(asked[0]).toMatchObject({ goal: "send hi", results: [{ name: "send", ok: true, summary: "send ran" }] });
  });
});

describe("S1: a settle summary goes through the finish check", () => {
  it("a failed check ends nothing and counts no check failure", async () => {
    const { loop } = await setup(
      [{ calls: [{ name: "send", args: {} }] }, slow({ calls: [{ name: "finish", args: { summary: "done" } }] }, 80, {})],
      async () => "sent",
      () => ({ ok: true, summary: "send ran", check: fail }),
    );
    const events = await collect(loop.run("send"));
    // The model's finish runs the check once: one check event, not two, and no feedback for the settle try.
    expect(ofType(events, "check")).toHaveLength(1);
    expect(ofType(events, "plan")).toHaveLength(2);
    expect(doneOf(events)).toBeUndefined();
  });

  it("a host check that fails keeps the model's answer", async () => {
    const send = tool("send");
    const { gate } = await gateFor([send.tool]);
    const mind = scriptedMind([{ calls: [{ name: "send", args: {} }] }, slow({ calls: [{ name: "finish", args: { summary: "planner" } }] }, 80, {})]);
    let checks = 0;
    const loop = createLoop({ mind, gate, tools: [send.tool], settle: async () => "helper", check: () => (++checks === 1 ? fail : pass) });
    const events = await collect(loop.run("send"));
    expect(last(events)).toMatchObject({ type: "done", summary: "planner" });
    expect((last(events) as { settled?: boolean }).settled).toBeUndefined();
  });
});

describe("S3: the model answers first", () => {
  it("aborts settle and ignores its late answer", async () => {
    let signal: AbortSignal | undefined;
    const { loop, other } = await setup(
      [{ calls: [{ name: "send", args: {} }] }, { calls: [{ name: "other", args: {} }] }, { calls: [{ name: "finish", args: { summary: "planner" } }] }],
      async (input) => {
        signal ??= input.signal;
        await wait(200);
        return "late";
      },
    );
    const events = await collect(loop.run("send"));
    expect(signal?.aborted).toBe(true);
    expect(other.runs).toHaveLength(1);
    expect(last(events)).toMatchObject({ type: "done", summary: "planner" });
  });
});

describe("S4: a settle that throws, hangs or says nothing", () => {
  for (const [name, settle] of [
    ["throws", async () => { throw new Error("helper down"); }],
    ["answers empty", async () => "  "],
    ["hangs", () => new Promise<string | undefined>(() => {})],
  ] as const) {
    it(`${name}: the model's answer counts`, async () => {
      const { loop } = await setup([{ calls: [{ name: "send", args: {} }] }, slow({ calls: [{ name: "finish", args: { summary: "planner" } }] }, 30, {})], settle);
      const events = await collect(loop.run("send"));
      expect(last(events)).toMatchObject({ type: "done", summary: "planner" });
    });
  }
});

describe("S5: settle runs only after a reply whose last tool result is ok", () => {
  it("not after the first read alone, a failed call, or a reply with no calls", async () => {
    const snapshot: LoopTool = { name: "snapshot", description: "read", scope: "read", parameters: { type: "object", properties: {} }, domain: () => DOMAIN, run: async () => ({ ok: true, summary: "read" }) };
    const send = tool("send", () => ({ ok: false, summary: "send failed" }));
    const tools = [snapshot, send.tool];
    const { gate } = await gateFor(tools, [{ scope: "fill", domains: [DOMAIN] }, { scope: "read", domains: [DOMAIN] }]);
    const mind = scriptedMind([{ calls: [{ name: "send", args: {} }] }, { text: "hmm" }, { calls: [{ name: "finish", args: { summary: "x" } }] }]);
    const asked: SettleInput[] = [];
    const loop = createLoop({ mind, gate, tools, firstRead: "snapshot", maxSteps: 3, settle: async (input) => (asked.push(input), "done") });
    await collect(loop.run("send"));
    expect(asked).toHaveLength(0);
  });

  it("not after a batch whose last call was skipped", async () => {
    const { loop, asked } = await setup([{ calls: [{ name: "send", args: {} }, { name: "nope", args: {} }] }, { calls: [{ name: "finish", args: { summary: "x" } }] }], async () => "done");
    await collect(loop.run("send"));
    expect(asked).toHaveLength(0);
  });
});

describe("S6: abort while settle and the model call run", () => {
  it("stops aborted at once, and both signals abort", async () => {
    const controller = new AbortController();
    const seen: { aborted?: boolean } = {};
    let settleSignal: AbortSignal | undefined;
    const { loop } = await setup([{ calls: [{ name: "send", args: {} }] }, slow({ text: "x" }, 5000, seen)], (input) => {
      settleSignal = input.signal;
      setTimeout(() => controller.abort(), 30);
      return new Promise(() => {});
    });
    const started = Date.now();
    const events = await collect(loop.run("send", { signal: controller.signal }));
    expect(last(events)?.type).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen.aborted).toBe(true);
    expect(settleSignal?.aborted).toBe(true);
  });
});

describe("S7: a long settle summary", () => {
  it("is cut to the summary limit and never goes to the model", async () => {
    const { loop, mind } = await setup([{ calls: [{ name: "send", args: {} }] }, slow({ text: "x" }, 300, {})], async () => "a".repeat(LIMITS.summary + 50));
    const events = await collect(loop.run("send"));
    expect((doneOf(events)?.summary ?? "").length).toBe(LIMITS.summary);
    expect(JSON.stringify(mind.seen)).not.toContain("a".repeat(100));
  });
});
