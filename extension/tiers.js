// The planner choices in the settings. Kept apart from mind.js, so the
// sidebar does not bundle foxmind. `cloud` ones send page text to the provider.
export const TIERS = [
  { id: "scripted", label: "Scripted (no model)" },
  { id: "ollama", label: "Ollama on this computer", model: "qwen3:0.6b" },
  { id: "llama-server", label: "llama-server on this computer" },
  { id: "saluki", label: "Underdog Saluki 27B (llama-server)" },
  { id: "openai", label: "Your own key: OpenAI-compatible", cloud: true, baseURL: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Your own key: Anthropic", cloud: true },
  { id: "browser", label: "In-browser small model (Qwen3-0.6B)" },
];
