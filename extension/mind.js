// The one place where the demo picks a planner and talks to foxmind. Each
// mind has one provider. The local and in-browser planners run in private
// mode, foxmind's `only: ["browser", "local"]`: foxmind refuses to build a
// mind whose provider is a cloud one, so page text stays on this computer.
import { anthropic, createMind, llamaServer, ollama, openaiCompatible, saluki } from "foxmind";
import { scriptMind } from "./script.js";
import { TIERS } from "./tiers.js";

async function provider(settings, apiKey) {
  const model = settings.model || undefined;
  switch (settings.tier) {
    case "ollama": return ollama({ model: model ?? "qwen3:0.6b" });
    case "llama-server": return llamaServer(model ? { model } : {});
    case "saluki": return saluki();
    case "openai": return openaiCompatible({ baseURL: settings.baseURL || "https://api.openai.com/v1", model: model ?? "gpt-4.1-mini", apiKey });
    case "anthropic": return anthropic({ apiKey, ...(model ? { model } : {}) });
    case "browser": return (await import("./browser-model.js")).transformers({ task: "chat" });
    default: throw new Error(`Unknown planner "${settings.tier}".`);
  }
}

/** The planner for the settings. The key lives in storage.session, so it is gone when Firefox closes. */
export async function mindFor(settings, goal) {
  if (!settings.tier || settings.tier === "scripted") return scriptMind(settings.script, goal);
  const tier = TIERS.find((t) => t.id === settings.tier);
  if (tier?.cloud && !settings.consent) throw new Error("Allow sending page text to this provider in the settings first.");
  const { apiKey } = await browser.storage.session.get("apiKey");
  return createMind({ providers: [await provider(settings, apiKey)], only: tier?.cloud ? ["cloud"] : ["browser", "local"] });
}
