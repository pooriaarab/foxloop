import type { Money, Scope } from "foxgate";

/** A JSON Schema object. foxloop checks a subset of it: see `checkArgs`. */
export type JsonSchema = Record<string, unknown>;

/** One line of a result check. */
export interface CheckLine {
  part: string;
  ok: boolean;
  evidence: string;
}

/** Did the work reach the goal? foxpaw's `verify` gives this shape. */
export interface CheckResult {
  ok: boolean;
  checks: CheckLine[];
  /** What is wrong with the page itself, for example "error page". */
  problem?: string;
}

/** What a tool returns. The loop sends `summary` and `untrusted` to the model. */
export interface ToolOutput {
  ok: boolean;
  /** Short text that your code writes. The model reads it as a result. */
  summary: string;
  /** Text from a web page or another outside source. The model gets it as data between delimiters. */
  untrusted?: string;
  /** Anything else for your app. It does not go to the model. */
  data?: unknown;
  /** A check of the result. The newest check decides if `finish` can pass. */
  check?: CheckResult;
}

/** What a tool gets besides its arguments. */
export interface ToolContext {
  signal: AbortSignal;
  /** The number of the model call that asked for this tool, from 1. */
  step: number;
  goal: string;
  /** The domain that foxgate judged. Set for `run` and `describe`, not for `domain`. */
  domain?: string;
}

/**
 * A tool the model can call. The host writes `scope`, `amount` and `domain`,
 * so the model cannot change what the gate judges.
 */
export interface LoopTool {
  /** 1-64 characters: letters, digits, `_` and `-`. */
  name: string;
  description: string;
  /** A JSON Schema with `type: "object"`. Arguments that do not fit never reach the gate. */
  parameters: JsonSchema;
  scope: Scope;
  /** For a tool that costs money: read the amount from the args. Needed for `pay`. */
  amount?: (args: Record<string, unknown>) => Money;
  /** The host name the action touches, for the gate. Throw to refuse the arguments. */
  domain: (args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
  /**
   * Host-side arguments, added after the schema check and before the gate.
   * The gate judges, the human approves and `run` gets the result. Throw to
   * refuse the call. The browser tools pin the control here.
   */
  prepare?: (args: Record<string, unknown>, ctx: ToolContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Plain words for the human who approves the call, for example "click the button "Pay"". Throw to refuse the call. */
  describe?: (args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>;
}
