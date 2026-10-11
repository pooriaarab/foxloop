// The ask_user tool: the planner asks the user one short question, the run
// waits, and the answer comes back as the result (docs/failure-modes.md U1-U9).
import type { LoopTool, ToolContext, ToolOutput } from "./types.js";

export const ASK_USER = "ask_user";
const DOMAIN = "user.foxloop";
const MAX_QUESTIONS = 3;
const MAX_ANSWER = 500;
const failed = (summary: string): ToolOutput => ({ ok: false, summary });

export interface AskUserOptions {
  /**
   * Shows the question to the user and resolves with the answer. Resolve
   * undefined (or throw) when the user gives none. `ctx.signal` aborts when
   * the run stops.
   */
  ask(question: string, ctx: ToolContext): Promise<string | undefined>;
  /** The gate domain of the tool. Grant it with scope "read". Default "user.foxloop". */
  domain?: string;
  /** The most questions in one run. Default 3. */
  max?: number;
}

/** The ask_user tool. It is a `read` tool on its own domain, so the gate sees each question (U9). */
export function askUserTool(options: AskUserOptions): LoopTool {
  const domain = options.domain ?? DOMAIN;
  const max = options.max ?? MAX_QUESTIONS;
  // One signal per run, so the count starts again at each run (U6).
  const asked = new WeakMap<AbortSignal, number>();
  return {
    name: ASK_USER,
    description: "Ask the user one short question and wait for the answer. Use it before you act when the goal lacks a detail only the user knows (a size, a choice, an OK to go over a limit the goal sets) or when a sign-in needs the user. Never ask for a password or a card number.",
    parameters: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 300 } }, required: ["question"] },
    scope: "read",
    domain: () => domain,
    describe: (args) => `ask you: "${String(args.question)}"`,
    run: async (args, ctx) => {
      const count = asked.get(ctx.signal) ?? 0;
      if (count >= max) return failed(`You asked ${max} questions in this run. Do not ask again: act on what you know.`);
      asked.set(ctx.signal, count + 1);
      let answer: string | undefined;
      try {
        answer = await options.ask(String(args.question), ctx);
      } catch {
        answer = undefined;
      }
      const text = (answer ?? "").trim().slice(0, MAX_ANSWER);
      if (!text) return failed("The user did not answer. Go on with what you know.");
      // Later calls of the reply were planned before the answer (U2).
      return { ok: true, summary: `The user answered: ${text}`, stopBatch: "the user answered a question" };
    },
  };
}
