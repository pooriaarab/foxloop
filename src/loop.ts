// The agent loop: ask the planner, check each tool call with foxgate, run
// the action foxgate judged, check the result, repeat. Each step is an event.
import type { Action, Gate } from "foxgate";
import { FoxloopError } from "./errors.js";
import { LIMITS, fitHistory, newNonce, plannerPrompt, resultText, type Message } from "./prompt.js";
import { checkArgs } from "./schema.js";
import { FINISH, defineTools } from "./tools.js";
import type { CheckResult, LoopTool, ToolContext, ToolOutput } from "./types.js";

/** A tool as the model sees it, in the OpenAI shape. */
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatReply {
  message: { role: "assistant"; content: string | null; tool_calls?: NonNullable<Message["tool_calls"]> };
  usage?: { inputTokens: number; outputTokens: number };
  /** Which provider and tier answered. foxmind sets both. */
  provider?: string;
  tier?: string;
}

/** The planner. A foxmind `Mind` fits this shape. */
export interface MindLike {
  chat(messages: Message[], options: { tools: ToolDef[]; signal?: AbortSignal }): Promise<ChatReply>;
}

export type BlockReason = "max-steps" | "repeated-call" | "repeated-failure" | "check-failed" | "model-error" | "gate-deny"
  | "gate-mismatch" | "gate-error" | "approval-denied" | "approval-unavailable" | "approval-error" | "trail-failed" | "budget";

/** Why a tool result failed before or while the tool ran. */
export type ResultReason = "invalid-args" | "unknown-tool" | "tool-error" | "failed";

export type LoopEvent =
  | { type: "plan"; step: number; text: string | null; calls: { id: string; name: string; args: string }[]; provider?: string; tier?: string }
  | { type: "tool-call"; step: number; id: string; name: string; args: unknown }
  | { type: "decision"; step: number; id: string; via: "check" | "redeem"; decision: "allow" | "ask" | "deny"; reason?: string; action?: Action }
  | { type: "approval-needed"; step: number; id: string; requestId: string; action: Action; expiresAt: number; detail?: string }
  | { type: "tool-result"; step: number; id: string; name: string; ok: boolean; summary: string; reason?: ResultReason; detail?: string; data?: unknown }
  | { type: "check"; step: number; ok: boolean; checks: CheckResult["checks"]; problem?: string }
  | { type: "done"; step: number; summary: string; check: CheckResult }
  | { type: "blocked"; step: number; reason: BlockReason; message: string }
  | { type: "aborted"; step: number };

/** What a host check gets when the model says it is done. */
export interface CheckInput {
  goal: string;
  summary: string;
  /** The check of the newest tool result, if that result had one. */
  lastCheck?: CheckResult;
}

export interface LoopOptions {
  mind: MindLike;
  /** The planner side of foxgate. Make it with `createFoxgate({ tools: toolSpecs(tools) })`. */
  gate: Gate;
  tools: LoopTool[];
  /** The most model calls in one run. Default 20. */
  maxSteps?: number;
  /** Decides if `finish` passes. Default: the newest tool result must carry a passing check. */
  check?: (input: CheckInput) => CheckResult | Promise<CheckResult>;
  /** Called when the gate asks. Show `action` to the human; return the token from `host.approve`, or null for no. */
  onApproval?: (request: ApprovalRequest) => Promise<string | null>;
  /** Gets one entry per event, before the loop goes on. A foxtrail `Log` fits. If a write fails, the run stops. */
  trail?: { append(entry: { actor: string; kind: string; data?: unknown }): Promise<unknown> };
  /** Stop the run when it uses this much. Tokens come from the model's usage, else from text length / 4. */
  budget?: { tokens?: number; toolCalls?: number; ms?: number };
  /** The clock in ms, for the time budget. Default: Date.now. */
  now?: () => number;
}

/** What `onApproval` gets. */
export interface ApprovalRequest {
  step: number;
  requestId: string;
  /** The exact action the token will allow. */
  action: Action;
  expiresAt: number;
  /** The tool's `describe` text, when the tool has one. */
  detail?: string;
}

export interface Loop {
  /** Runs one goal. Read the events with `for await`. Stop reading to stop the run. */
  run(goal: string, options?: { signal?: AbortSignal }): AsyncGenerator<LoopEvent, void, undefined>;
}

const NOTHING: CheckResult = { ok: false, checks: [{ part: "result", ok: false, evidence: "nothing checked the result" }] };
const FAIL_LIMIT = 3;
const REPEAT_LIMIT = 3;
const CHECK_LIMIT = 2;

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};
/** Runs fn and returns its value, or the error message cut to LIMITS.error. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ value: T; error?: undefined } | { value?: undefined; error: string }> {
  try {
    return { value: await fn() };
  } catch (cause) {
    return { error: message(cause) };
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, LIMITS.error);

const defsOf = (tools: Iterable<LoopTool>): ToolDef[] => [
  ...[...tools].map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
  {
    type: "function",
    function: {
      name: FINISH,
      description: "Call this when the goal is reached. foxloop then checks the result.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
  },
];

const ABORTED = Symbol("aborted");
const textOf = (messages: { content: string | null; tool_calls?: unknown }[]) =>
  messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
const dataOf = (event: LoopEvent) => {
  const { type: _type, ...data } = event;
  return JSON.parse(JSON.stringify(data)) as unknown;
};

const failedChecks = (check: CheckResult) =>
  check.checks.filter((c) => !c.ok).map((c) => `${c.part}: ${c.evidence}`).concat(check.problem ? [check.problem] : []).join("; ");

export function createLoop(options: LoopOptions): Loop {
  const tools = defineTools(options.tools);
  const maxSteps = options.maxSteps ?? 20;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new FoxloopError("bad-options", "maxSteps must be a whole number of 1 or more");
  const defs = defsOf(tools.values());
  let running = false;

  const now = options.now ?? Date.now;
  const overBudget = (used: number, ms: number) => {
    const budget = options.budget ?? {};
    if (budget.tokens !== undefined && used >= budget.tokens) return `the run used ${used} of ${budget.tokens} tokens`;
    if (budget.ms !== undefined && ms >= budget.ms) return `the run took ${ms} of ${budget.ms} ms`;
    return undefined;
  };

  /** Writes each event to the trail before it goes on. A failed write stops the run, and the inner steps never resume. */
  async function* run(goal: string, runOptions: { signal?: AbortSignal } = {}): AsyncGenerator<LoopEvent, void, undefined> {
    const inner = steps(goal, runOptions);
    try {
      for await (const event of inner) {
        try {
          await options.trail?.append({ actor: "foxloop", kind: `loop.${event.type}`, data: dataOf(event) });
        } catch (cause) {
          const stop: LoopEvent = { type: "blocked", step: event.step, reason: "trail-failed", message: `the trail write failed: ${message(cause)}` };
          await options.trail?.append({ actor: "foxloop", kind: "loop.blocked", data: dataOf(stop) }).catch(() => undefined);
          return yield stop;
        }
        yield event;
      }
    } finally {
      await inner.return(undefined);
    }
  }

  async function* steps(goal: string, runOptions: { signal?: AbortSignal } = {}): AsyncGenerator<LoopEvent, void, undefined> {
    if (running) throw new FoxloopError("busy", "a run is in progress on this loop");
    running = true;
    const signal = runOptions.signal ?? new AbortController().signal;
    const started = now();
    let [tokens, runs] = [0, 0];
    /** Resolves with ABORTED when the run is aborted, so a call that ignores the signal cannot hold the run. */
    const race = <T>(work: Promise<T>): Promise<T | typeof ABORTED> =>
      signal.aborted ? Promise.resolve(ABORTED) : Promise.race([work, new Promise<typeof ABORTED>((resolve) => signal.addEventListener("abort", () => resolve(ABORTED), { once: true }))]);
    const nonce = newNonce();
    const messages: Message[] = [{ role: "system", content: plannerPrompt(nonce) }, { role: "user", content: `Goal: ${goal}` }];
    let [step, failures, checkFails, repeats, lastKey] = [0, 0, 0, 0, ""];
    let lastCheck: CheckResult | undefined;
    const blocked = (reason: BlockReason, text: string): LoopEvent => ({ type: "blocked", step, reason, message: text });

    /** Runs one tool call. Returns a stop event, or undefined to go on. */
    async function* call(id: string, name: string, raw: string): AsyncGenerator<LoopEvent, LoopEvent | undefined, undefined> {
      /** `detail` may hold outside text, so the model gets it only as delimited data. */
      const fail = (reason: ResultReason, summary: string, detail?: string): LoopEvent => {
        lastCheck = undefined;
        messages.push({ role: "tool", tool_call_id: id, content: resultText(name, { ok: false, summary, untrusted: detail }, nonce) });
        return { type: "tool-result", step, id, name, ok: false, summary, reason, ...(detail ? { detail } : {}) };
      };
      const args = parse(raw);
      yield { type: "tool-call", step, id, name, args };
      if (raw.includes(nonce)) return yield* failed(fail("invalid-args", "The arguments hold the data marker. Do not copy markers into arguments."));
      const tool = tools.get(name);
      if (!tool) return yield* failed(fail("unknown-tool", `There is no tool "${name}". Tools: ${defs.map((d) => d.function.name).join(", ")}.`));
      const error = checkArgs(tool.parameters, args);
      if (error) return yield* failed(fail("invalid-args", error));
      const ctx: ToolContext = { signal, step, goal };
      const domain = await attempt(async () => tool.domain(args as Record<string, unknown>, ctx));
      if (domain.error !== undefined) return yield* failed(fail("invalid-args", domain.error));
      const action: Action = { tool: name, args: args as Record<string, unknown>, domain: domain.value, scope: tool.scope };
      const checked = await attempt(() => options.gate.check(action));
      if (checked.error !== undefined) return blocked("gate-error", checked.error);
      let decision = checked.value;
      yield { type: "decision", step, id, via: "check", decision: decision.decision, ...(decision.decision === "deny" ? { reason: decision.reason } : {}), action };
      if (decision.decision === "deny") return blocked("gate-deny", `${decision.reason}: ${decision.message}`);
      if (decision.decision === "ask") {
        if (!options.onApproval) return blocked("approval-unavailable", "the gate asks for approval, and the loop has no onApproval");
        const described = tool.describe ? await attempt(async () => String(await tool.describe?.(action.args, { ...ctx, domain: action.domain }))) : undefined;
        if (described?.error !== undefined) return blocked("approval-error", `the tool cannot describe the action: ${described.error}`);
        const request: ApprovalRequest = { step, requestId: decision.requestId, action, expiresAt: decision.expiresAt, ...(described ? { detail: described.value } : {}) };
        yield { type: "approval-needed", id, ...request };
        const asked = await race(attempt(async () => options.onApproval?.(request)));
        if (asked === ABORTED) return { type: "aborted", step };
        if (asked.error !== undefined) return blocked("approval-error", asked.error);
        if (typeof asked.value !== "string" || !asked.value) return blocked("approval-denied", "the human did not approve the action");
        const token = asked.value;
        const redeemed = await attempt(() => options.gate.redeem(token, action));
        if (redeemed.error !== undefined) return blocked("gate-error", redeemed.error);
        decision = redeemed.value;
        yield { type: "decision", step, id, via: "redeem", decision: decision.decision, ...(decision.decision === "deny" ? { reason: decision.reason } : {}), action };
        if (decision.decision !== "allow") return blocked("gate-deny", decision.decision === "deny" ? `${decision.reason}: ${decision.message}` : "the gate asked again");
      }
      if (options.budget?.toolCalls !== undefined && runs >= options.budget.toolCalls) return blocked("budget", `the run used its ${options.budget.toolCalls} tool calls`);
      runs++;
      if (decision.action.tool !== name) return blocked("gate-mismatch", `the gate allowed "${decision.action.tool}", not "${name}"`);
      const judged = decision.action;
      const ran = await race(attempt(() => tool.run(judged.args, { ...ctx, domain: judged.domain })));
      if (ran === ABORTED) return { type: "aborted", step };
      if (ran.error !== undefined) return yield* failed(fail("tool-error", "The tool threw an error. Its message is below.", ran.error));
      const output: ToolOutput = ran.value;
      lastCheck = output.check;
      messages.push({ role: "tool", tool_call_id: id, content: resultText(name, output, nonce) });
      const result: LoopEvent = { type: "tool-result", step, id, name, ok: output.ok, summary: output.summary.slice(0, LIMITS.summary), ...(output.ok ? {} : { reason: "failed" as const }), data: output.data };
      return yield* failed(result);
    }
    /** Yields a result and counts failures in a row. */
    async function* failed(result: LoopEvent): AsyncGenerator<LoopEvent, LoopEvent | undefined, undefined> {
      yield result;
      failures = result.type === "tool-result" && !result.ok ? failures + 1 : 0;
      return failures >= FAIL_LIMIT ? blocked("repeated-failure", `${FAIL_LIMIT} tool results failed in a row`) : undefined;
    }
    /** The model says it is done. Returns a stop event, or undefined to go on. */
    async function* finish(summary: string, id?: string): AsyncGenerator<LoopEvent, LoopEvent | undefined, undefined> {
      const tried = await attempt(async () => (options.check ? options.check({ goal, summary, lastCheck }) : (lastCheck ?? NOTHING)));
      const check: CheckResult = tried.value ?? { ok: false, checks: [{ part: "check", ok: false, evidence: tried.error ?? "" }] };
      yield { type: "check", step, ok: check.ok, checks: check.checks, ...(check.problem ? { problem: check.problem } : {}) };
      if (check.ok) return { type: "done", step, summary, check };
      checkFails++;
      const feedback = resultText(FINISH, { ok: false, summary: "The check failed. Fix it, then call finish again.", untrusted: failedChecks(check) }, nonce);
      messages.push(id ? { role: "tool", tool_call_id: id, content: feedback } : { role: "user", content: feedback });
      return checkFails >= CHECK_LIMIT ? blocked("check-failed", failedChecks(check)) : undefined;
    }

    try {
      while (true) {
        if (signal.aborted) return yield { type: "aborted", step };
        if (step >= maxSteps) return yield blocked("max-steps", `the planner made ${maxSteps} calls without a passing finish`);
        const over = overBudget(tokens, now() - started);
        if (over) return yield blocked("budget", over);
        step++;
        const history = fitHistory(messages, nonce);
        const answer = await race(attempt(() => options.mind.chat(history, { tools: defs, signal })));
        if (answer === ABORTED || signal.aborted) return yield { type: "aborted", step };
        if (answer.error !== undefined) return yield blocked("model-error", answer.error);
        const reply: ChatReply = answer.value;
        tokens += reply.usage ? reply.usage.inputTokens + reply.usage.outputTokens : Math.ceil((textOf(history) + textOf([reply.message])) / 4);
        const calls = reply.message.tool_calls ?? [];
        yield {
          type: "plan", step, text: reply.message.content, calls: calls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments })),
          ...(reply.provider ? { provider: reply.provider } : {}), ...(reply.tier ? { tier: reply.tier } : {}),
        };
        messages.push({ role: "assistant", content: reply.message.content, ...(calls.length ? { tool_calls: calls } : {}) });
        let stop: LoopEvent | undefined;
        if (calls.length === 0) stop = yield* finish(reply.message.content ?? "");
        for (const c of calls) {
          if (stop) break;
          if (c.function.name === FINISH) {
            const args = parse(c.function.arguments) as { summary?: unknown };
            stop = yield* finish(typeof args?.summary === "string" ? args.summary : c.function.arguments, c.id);
            continue;
          }
          const key = `${c.function.name} ${c.function.arguments}`;
          repeats = key === lastKey ? repeats + 1 : 1;
          lastKey = key;
          if (signal.aborted) stop = { type: "aborted", step };
          else stop = repeats >= REPEAT_LIMIT
            ? blocked("repeated-call", `the planner asked for the same ${c.function.name} call ${REPEAT_LIMIT} times in a row`)
            : yield* call(c.id, c.function.name, c.function.arguments);
        }
        if (stop) return yield stop;
      }
    } finally {
      running = false;
    }
  }

  return { run };
}
