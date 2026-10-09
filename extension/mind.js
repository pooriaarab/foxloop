// The one place where the demo picks a planner. This build has the
// scripted planner only; model tiers come in the settings change.
import { scriptMind } from "./script.js";

/** The planner for the settings. */
export async function mindFor(settings, goal) {
  return scriptMind(settings.script, goal);
}
