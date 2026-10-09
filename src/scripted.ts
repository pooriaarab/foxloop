// A fake planner that returns fixed replies, for tests and offline demos.
import type { Message } from "./prompt.js";
import type { ChatReply, MindLike } from "./loop.js";

/** One planned reply: some text, some tool calls, or both. */
export interface ScriptReply {
  text?: string;
  /** `args` is an object, or a raw string to send as the arguments text. */
  calls?: { name: string; args: Record<string, unknown> | string }[];
}

/** A reply, or a function that makes one from the history so far. */
export type ScriptStep = ScriptReply | ((messages: Message[], signal?: AbortSignal) => ScriptReply | Promise<ScriptReply>);

/**
 * A planner that replies with `steps` in order, one per model call. It
 * throws after the last step. `seen` holds the messages of each call.
 */
export function scriptedMind(steps: ScriptStep[]): MindLike & { seen: Message[][] } {
  const seen: Message[][] = [];
  let calls = 0;
  return {
    seen,
    async chat(messages, options): Promise<ChatReply> {
      seen.push(structuredClone(messages));
      const step = steps[seen.length - 1];
      if (!step) throw new Error(`the script has ${steps.length} replies, and the loop asked for more`);
      const reply = typeof step === "function" ? await step(messages, options?.signal) : step;
      const toolCalls = (reply.calls ?? []).map((call) => ({
        id: `call_${++calls}`,
        type: "function" as const,
        function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) },
      }));
      return {
        message: { role: "assistant", content: reply.text ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        provider: "scripted",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}
