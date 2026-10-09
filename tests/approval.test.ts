// Failure modes G1-G9 and T1-T3 in docs/failure-modes.md: every call goes
// through the gate, approvals are exact and one-time, and the trail is
// written before the loop goes on.
import type { Gate } from "foxgate";
import { describe, expect, it } from "vitest";
import { createLoop, scriptedMind, type LoopTool } from "../src/index.js";
import { DOMAIN, collect, gateFor, last, noteTool, ofType } from "./helpers.js";

const ok = { ok: true, checks: [{ part: "sent", ok: true, evidence: "sent" }] };
const send = (text = "hi") => ({ calls: [{ name: "send_note", args: { text } }] });
const finish = { calls: [{ name: "finish", args: { summary: "sent" } }] };

/** A submit tool: foxgate asks a human before each send. */
function sendTool() {
  const runs: Record<string, unknown>[] = [];
  const tool: LoopTool = {
    name: "send_note",
    description: "Send a note.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    scope: "submit",
    domain: () => DOMAIN,
    run: async (args) => {
      runs.push(args);
      return { ok: true, summary: "sent", check: ok };
    },
  };
  return { tool, runs };
}

async function asking() {
  const s = sendTool();
  const g = await gateFor([s.tool], [{ scope: "submit", domains: [DOMAIN] }]);
  return { ...s, ...g };
}

describe("G1-G3: the gate judges every call", () => {
  it("G1: runs the action foxgate judged, not the model's copy", async () => {
    const note = noteTool(() => ({ ok: true, summary: "saved", check: ok }));
    const { gate: real } = await gateFor([note.tool]);
    const gate: Gate = {
      check: async (action) => {
        const decision = await real.check(action);
        return decision.decision === "allow" ? { ...decision, action: { ...decision.action, args: { text: "judged" } } } : decision;
      },
      redeem: real.redeem,
    };
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "model" } }] }, finish]), gate, tools: [note.tool] }).run("Save."));
    expect(note.runs).toEqual([{ text: "judged" }]);
    expect(ofType(events, "decision")[0]).toMatchObject({ via: "check", decision: "allow" });
  });

  it("G2: a decision for another tool runs nothing", async () => {
    const note = noteTool();
    const gate: Gate = {
      check: async () => ({ decision: "allow", grantId: "g", action: { tool: "other", args: {}, domain: DOMAIN, scope: "fill" } }),
      redeem: async () => ({ decision: "deny", reason: "bad-token", message: "no" }),
    };
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }]), gate, tools: [note.tool] }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "gate-mismatch" });
    expect(note.runs).toEqual([]);
  });

  it("G3: deny runs nothing and stops with the foxgate reason", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool], []);
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }]), gate, tools: [note.tool] }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "gate-deny" });
    expect((last(events) as { message: string }).message).toMatch(/^no-grant/);
    expect(note.runs).toEqual([]);
  });
});

describe("G4-G8: approvals", () => {
  it("asks once, redeems the token, and runs the exact action", async () => {
    const { tool, runs, gate, host, seen } = await asking();
    const requests: unknown[] = [];
    const onApproval = async (request: { requestId: string }) => {
      requests.push(request);
      return host.approve(request.requestId);
    };
    const events = await collect(createLoop({ mind: scriptedMind([send(), finish]), gate, tools: [tool], onApproval }).run("Send hi."));
    expect(requests).toEqual([expect.objectContaining({ requestId: expect.any(String), action: expect.objectContaining({ tool: "send_note", args: { text: "hi" }, scope: "submit" }) })]);
    expect(ofType(events, "approval-needed").length).toBe(1);
    expect(seen).toEqual(["check:send_note", "redeem:send_note"]);
    expect(ofType(events, "decision").map((d) => `${d.via}:${d.decision}`)).toEqual(["check:ask", "redeem:allow"]);
    expect(runs).toEqual([{ text: "hi" }]);
    expect(last(events)?.type).toBe("done");
  });

  it("G4: a human who says no stops the run, and nothing runs", async () => {
    const { tool, runs, gate } = await asking();
    const events = await collect(createLoop({ mind: scriptedMind([send()]), gate, tools: [tool], onApproval: async () => null }).run("Send."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "approval-denied" });
    expect(runs).toEqual([]);
  });

  it("G5: ask with no onApproval stops the run", async () => {
    const { tool, runs, gate } = await asking();
    const events = await collect(createLoop({ mind: scriptedMind([send()]), gate, tools: [tool] }).run("Send."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "approval-unavailable" });
    expect(runs).toEqual([]);
  });

  it("G6: a used token is refused, and nothing runs again", async () => {
    const { tool, runs, gate, host } = await asking();
    let token = "";
    const onApproval = async (request: { requestId: string }) => (token ||= await host.approve(request.requestId));
    const events = await collect(createLoop({ mind: scriptedMind([send("a"), send("b")]), gate, tools: [tool], onApproval }).run("Send."));
    expect(runs).toEqual([{ text: "a" }]);
    expect(last(events)).toMatchObject({ type: "blocked", reason: "gate-deny" });
    expect((last(events) as { message: string }).message).toMatch(/^(token-used|action-changed)/);
  });

  it("G6: a forged token is refused", async () => {
    const { tool, runs, gate } = await asking();
    const events = await collect(createLoop({ mind: scriptedMind([send()]), gate, tools: [tool], onApproval: async () => "forged.token" }).run("Send."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "gate-deny" });
    expect(runs).toEqual([]);
  });

  it("G7: onApproval that throws stops the run", async () => {
    const { tool, runs, gate } = await asking();
    const onApproval = async (): Promise<string> => {
      throw new Error("the sidebar closed");
    };
    const events = await collect(createLoop({ mind: scriptedMind([send()]), gate, tools: [tool], onApproval }).run("Send."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "approval-error" });
    expect(runs).toEqual([]);
  });

  it("G8: a gate that throws stops the run", async () => {
    const note = noteTool();
    const gate: Gate = { check: async () => Promise.reject(new Error("storage gone")), redeem: async () => Promise.reject(new Error("x")) };
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }]), gate, tools: [note.tool] }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "gate-error" });
    expect(note.runs).toEqual([]);
  });

  it("G9: a domain function that throws is a failed result, and the gate never sees it", async () => {
    const note = noteTool();
    const tool = { ...note.tool, domain: () => {
      throw new Error("only http and https addresses open");
    } };
    const { gate, seen } = await gateFor([tool]);
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }]), gate, tools: [tool], maxSteps: 1 }).run("Save."));
    expect(ofType(events, "tool-result")[0]).toMatchObject({ ok: false, reason: "invalid-args", summary: "only http and https addresses open" });
    expect(seen).toEqual([]);
  });
});

describe("T1-T3: the trail", () => {
  const trailOf = (failOn?: string) => {
    const entries: { actor: string; kind: string; data?: unknown }[] = [];
    return {
      entries,
      append: async (entry: { actor: string; kind: string; data?: unknown }) => {
        if (entry.kind === failOn) throw new Error("disk full");
        entries.push(entry);
      },
    };
  };

  it("T1: every event goes in, the decision before the tool runs", async () => {
    const { tool, gate, host } = await asking();
    const trail = trailOf();
    let kindsAtRun: string[] = [];
    const watched = { ...tool, run: async (args: Record<string, unknown>, ctx: Parameters<LoopTool["run"]>[1]) => {
      kindsAtRun = trail.entries.map((e) => e.kind);
      return tool.run(args, ctx);
    } };
    const onApproval = async (request: { requestId: string }) => host.approve(request.requestId);
    const events = await collect(createLoop({ mind: scriptedMind([send(), finish]), gate, tools: [watched], trail, onApproval }).run("Send."));
    expect(trail.entries.map((e) => e.kind)).toEqual(events.map((e) => `loop.${e.type}`));
    expect(kindsAtRun).toEqual(["loop.plan", "loop.tool-call", "loop.decision", "loop.approval-needed", "loop.decision"]);
    expect(trail.entries.every((e) => e.actor === "foxloop")).toBe(true);
  });

  it("T1: a denied approval is in the trail", async () => {
    const { tool, gate } = await asking();
    const trail = trailOf();
    await collect(createLoop({ mind: scriptedMind([send()]), gate, tools: [tool], trail, onApproval: async () => null }).run("Send."));
    expect(trail.entries.at(-1)).toMatchObject({ kind: "loop.blocked", data: { reason: "approval-denied" } });
  });

  it("T2: a failed write before the tool stops the run, and nothing runs", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const trail = trailOf("loop.decision");
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }]), gate, tools: [note.tool], trail }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "trail-failed" });
    expect(note.runs).toEqual([]);
  });

  it("T3: a failed write after the tool stops the run before the next model call", async () => {
    const note = noteTool();
    const { gate } = await gateFor([note.tool]);
    const trail = trailOf("loop.tool-result");
    const mind = scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }, finish]);
    const events = await collect(createLoop({ mind, gate, tools: [note.tool], trail }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "trail-failed" });
    expect(note.runs.length).toBe(1);
    expect(mind.seen.length).toBe(1);
  });

  it("T3: a failed write of the stop entry turns done into trail-failed", async () => {
    const note = noteTool(() => ({ ok: true, summary: "saved", check: ok }));
    const { gate } = await gateFor([note.tool]);
    const events = await collect(createLoop({ mind: scriptedMind([{ calls: [{ name: "save_note", args: { text: "a" } }] }, finish]), gate, tools: [note.tool], trail: trailOf("loop.done") }).run("Save."));
    expect(last(events)).toMatchObject({ type: "blocked", reason: "trail-failed" });
  });
});
