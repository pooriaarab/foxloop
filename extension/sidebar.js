// The demo sidebar: a goal box, each event of the run, inline approvals,
// and the planner settings. The E2E test drives the same code through
// window.foxloopDemo.
import { DEFAULT_SCRIPT } from "./script.js";
import { TIERS } from "./tiers.js";

const HINTS = {
  scripted: "Replays the script below. No model runs. {{goal}} becomes your goal.",
  ollama: "Start Ollama with OLLAMA_ORIGINS=\"moz-extension://*\", or it refuses the extension.",
  "llama-server": "Start llama-server with --jinja on port 8080.",
  saluki: "Start llama-server with the Saluki GGUF on port 8080. See the foxmind README.",
  openai: "Any OpenAI-compatible API. Page text goes to this provider.",
  anthropic: "Page text goes to Anthropic.",
  browser: "Downloads about 500 MB the first time. Slow on WASM.",
};
const $ = (id) => document.getElementById(id);
let port;

/** The id of the newest tab whose address starts with `prefix`. */
async function tabFor(prefix) {
  const tab = (await browser.tabs.query({})).findLast((t) => t.url?.startsWith(prefix));
  if (!tab) throw new Error(`No tab at ${prefix}`);
  return tab.id;
}

function item(kind, text, className = "") {
  const li = document.createElement("li");
  li.className = className;
  const label = document.createElement("span");
  label.className = "kind";
  label.textContent = kind;
  li.append(label, document.createTextNode(text));
  $("events").append(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

function approval(event) {
  const li = item("Approve?", ` ${event.action.tool} on ${event.action.domain}`, "ask");
  const detail = document.createElement("p");
  detail.className = "detail";
  detail.textContent = event.detail ?? "";
  const pre = document.createElement("pre");
  pre.textContent = event.text ?? JSON.stringify(event.action, null, 1);
  const row = document.createElement("div");
  row.className = "row";
  for (const [label, op] of [["Approve", "approve"], ["Deny", "deny"]]) {
    const button = document.createElement("button");
    button.textContent = label;
    button.dataset.op = op;
    button.addEventListener("click", () => {
      port.postMessage({ op, requestId: event.requestId });
      row.replaceWith(document.createTextNode(op === "approve" ? "Approved." : "Denied."));
    });
    row.append(button);
  }
  li.append(...(event.detail ? [detail] : []), pre, row);
}

function show(event) {
  if (event.type === "plan") {
    const calls = event.calls.map((c) => `${c.name}(${c.args})`).join(", ");
    item("Plan", ` ${calls || event.text || "(no call)"}${event.provider ? ` [${event.provider}${event.tier ? `, ${event.tier}` : ""}]` : ""}`);
  } else if (event.type === "decision") {
    item("Gate", ` ${event.via} ${event.decision}${event.reason ? `: ${event.reason}` : ""}`, event.decision === "deny" ? "bad" : "");
  } else if (event.type === "approval-needed") {
    approval(event);
  } else if (event.type === "tool-result") {
    item(event.ok ? "Result" : "Failed", ` ${event.name}: ${event.summary}`, event.ok ? "ok" : "bad");
  } else if (event.type === "check") {
    item(event.ok ? "Check passed" : "Check failed", ` ${event.checks.map((c) => `${c.ok ? "ok" : "not ok"} ${c.part}`).join("; ")}`, event.ok ? "ok" : "bad");
  }
}

function end(text, className) {
  $("status").textContent = text;
  $("status").className = className;
  $("run").disabled = false;
  $("stop").disabled = true;
}

/** Runs a goal on a tab in the background page and shows each event. */
async function start(tabId, goal) {
  const { settings = {} } = await browser.storage.local.get("settings");
  $("goal").value = goal;
  $("events").replaceChildren();
  $("run").disabled = true;
  $("stop").disabled = false;
  $("status").className = "";
  $("status").textContent = "Running…";
  port?.disconnect();
  port = browser.runtime.connect({ name: "loop" });
  port.onMessage.addListener(({ event, error }) => {
    if (error) return end(error, "bad");
    show(event);
    if (event.type === "done") end(`Done: ${event.summary}`, "done");
    if (event.type === "blocked") end(`Blocked (${event.reason}): ${event.message}`, "bad");
    if (event.type === "aborted") end("Stopped.", "bad");
    return undefined;
  });
  port.postMessage({ op: "run", tabId, goal, settings });
}

$("goal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await start(tab.id, $("goal").value).catch((error) => end(error.message, "bad"));
});
async function loadSettings() {
  const { settings = {} } = await browser.storage.local.get("settings");
  $("tier").replaceChildren(...TIERS.map((t) => new Option(t.label, t.id)));
  $("tier").value = settings.tier ?? "scripted";
  $("model").value = settings.model ?? "";
  $("base-url").value = settings.baseURL ?? "";
  $("consent").checked = Boolean(settings.consent);
  $("script").value = settings.script || DEFAULT_SCRIPT;
  showTier();
}

function showTier() {
  const tier = TIERS.find((t) => t.id === $("tier").value) ?? TIERS[0];
  $("tier-name").textContent = tier.label;
  $("hint").textContent = HINTS[tier.id];
  $("model").placeholder = tier.model ?? "the provider's default";
  $("base-url").placeholder = tier.baseURL ?? "";
  for (const div of document.querySelectorAll("[data-for]")) div.hidden = !div.dataset.for.split(" ").includes(tier.id);
}

async function saveSettings() {
  showTier();
  const settings = { tier: $("tier").value, model: $("model").value.trim(), baseURL: $("base-url").value.trim(), consent: $("consent").checked, script: $("script").value };
  await browser.storage.local.set({ settings });
}

$("settings").addEventListener("change", saveSettings);
$("api-key").addEventListener("change", () => browser.storage.session.set({ apiKey: $("api-key").value }));
$("consent").addEventListener("click", async () => {
  if (!$("consent").checked) return;
  // Firefox's own consent prompt for page text, where the API exists.
  const granted = await browser.permissions.request({ data_collection: ["websiteContent"] }).catch(() => true);
  if (!granted) $("consent").checked = false;
  await saveSettings();
});
loadSettings();

$("stop").addEventListener("click", () => port?.postMessage({ op: "stop" }));

window.foxloopDemo = { start, tabFor, loadSettings };
