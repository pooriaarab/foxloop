// The "Scripted (no model)" planner of the demo. It replays a JSON list of
// tool calls, so the demo and the E2E test run with no model. In string
// arguments, {{goal}} becomes the goal, and {{lastUrl}} becomes the last
// http or https address in the newest tool result, as a naive model might
// copy it from a page. {{control:Some label}} becomes the id of the first
// control in the newest snapshot whose label has that text.
import { scriptedMind } from "../src/index.ts";

export const DEFAULT_SCRIPT = JSON.stringify([
  { tool: "snapshot", args: {} },
  { tool: "browser_task", args: { goal: "{{goal}}" } },
  { tool: "finish", args: { summary: "foxpaw filled and sent the form." } },
], null, 1);

const lastUrl = (messages) => {
  const text = messages.findLast((m) => m.role === "tool")?.content ?? "";
  return text.match(/https?:\/\/[^\s"'<>)]+/g)?.at(-1) ?? "";
};

const controlId = (messages, label) => {
  const text = messages.findLast((m) => m.role === "tool" && m.content?.includes("Controls:"))?.content ?? "";
  return text.split("\n").find((line) => line.startsWith("[") && line.includes(label))?.match(/^\[([^\]]+)\]/)?.[1] ?? "";
};

/** A foxloop planner that replays `script` (JSON text) for `goal`. Throws on bad JSON. */
export function scriptMind(script, goal) {
  const steps = JSON.parse(script || DEFAULT_SCRIPT);
  if (!Array.isArray(steps)) throw new Error("The script must be a JSON array of steps.");
  return scriptedMind(steps.map((step) => (messages) => {
    const fill = (value) => {
      if (typeof value === "string") {
        return value.replaceAll("{{goal}}", goal).replaceAll("{{lastUrl}}", lastUrl(messages))
          .replace(/\{\{control:([^}]+)\}\}/g, (_, label) => controlId(messages, label));
      }
      if (Array.isArray(value)) return value.map(fill);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
      return value;
    };
    return step.tool ? { calls: [{ name: step.tool, args: fill(step.args ?? {}) }] } : { text: fill(step.text ?? "") };
  }));
}
