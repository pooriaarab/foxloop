// The browser tool pack: foxpaw's read, act and run-task calls as loop
// tools. Every page function is bundled in foxpaw; no tool runs model code.
import * as foxpaw from "foxpaw";
import type { ActRequest, Chooser, RunOptions, RunResult, ScriptingApi, Snapshot } from "foxpaw";
import type { LoopTool, ToolContext, ToolOutput } from "./types.js";

/** The `browser.tabs` calls the pack uses. */
export interface TabsLike {
  get(tabId: number): Promise<{ url?: string; status?: string }>;
  update(tabId: number, props: { url: string }): Promise<unknown>;
}

/** The foxpaw calls the pack uses. Default: foxpaw itself. */
export interface PawLike {
  snapshot(tabId: number, browser?: ScriptingApi): Promise<Snapshot>;
  act: typeof foxpaw.act;
  settle(tabId: number, options?: { frameId?: number }, browser?: ScriptingApi): Promise<number>;
  runTask(tabId: number, goal: string, options?: RunOptions): Promise<RunResult>;
}

export interface BrowserToolsOptions {
  /** The tab the tools work on, read at each call. */
  tabId: () => number | Promise<number>;
  /** The WebExtension `browser` object. Default: the global one. */
  browser?: ScriptingApi & { tabs: TabsLike };
  /** The foxpaw chooser for `browser_task`. Default: foxpaw's `ruleChooser()`. */
  chooser?: Chooser;
  paw?: PawLike;
}

const MAX_CONTROLS = 40;
const LOAD_WAIT_MS = 15_000;
const OPS = ["type", "select", "check", "uncheck", "date", "scroll"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const hostOf = (url: string | undefined): string => {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new Error(`"${url}" is not an address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only http and https addresses open");
  return parsed.hostname;
};

/** The page as text for the model. All of it comes from the page, so it is untrusted. */
function pageText(page: Snapshot): string {
  const lines = page.controls.slice(0, MAX_CONTROLS).map((c) => {
    const flags = [c.required && "required", c.disabled && "disabled", c.checked && "checked", c.submit && "sends the form"].filter(Boolean);
    const options = c.options?.length ? ` options=${JSON.stringify(c.options.map((o) => o.value))}` : "";
    return `[${c.id}] ${c.role} "${c.label}"${c.value ? ` value="${c.value}"` : ""}${options}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  const more = page.controls.length - MAX_CONTROLS;
  if (more > 0) lines.push(`... ${more} more controls`);
  return [`Title: ${page.title}`, `Address: ${page.url}`, "Controls:", ...lines, "Text:", page.text].join("\n");
}

/**
 * The browser tools: `snapshot`, `act`, `click`, `open_url` and
 * `browser_task`. The domain of each call is the host of the tab address
 * (or of the address that `open_url` opens), read when the call runs.
 */
export function browserTools(options: BrowserToolsOptions): LoopTool[] {
  const paw: PawLike = options.paw ?? foxpaw;
  const api = () => options.browser ?? (globalThis as unknown as { browser: ScriptingApi & { tabs: TabsLike } }).browser;
  let last: { tabId: number; page: Snapshot } | undefined;
  const tabDomain = async () => {
    const tab = await api().tabs.get(await options.tabId());
    if (!tab.url?.startsWith("http")) throw new Error("the tab shows no web page");
    return hostOf(tab.url);
  };
  const read = async (tabId: number) => {
    last = { tabId, page: await paw.snapshot(tabId, api()) };
    return last.page;
  };
  const operate = async (args: Record<string, unknown>, request: ActRequest): Promise<ToolOutput> => {
    const tabId = await options.tabId();
    const page = last?.tabId === tabId ? last.page : undefined;
    if (!page) return { ok: false, summary: "There is no snapshot of this page. Call snapshot first." };
    const control = page.controls.find((c) => c.id === args.controlId);
    if (!control) return { ok: false, summary: `No control has the id "${String(args.controlId)}" in the last snapshot. Call snapshot to read the page again.` };
    const result = await paw.act(tabId, control, request, page, api());
    if (!result.ok) {
      last = undefined;
      return { ok: false, summary: `foxpaw did not act: ${result.reason}${result.detail ? ` (${result.detail})` : ""}. Call snapshot to read the page again.` };
    }
    await paw.settle(tabId, { frameId: control.frameId }, api());
    const after = await read(tabId).catch(() => undefined);
    const sent = result.submitted ? " The form was sent." : "";
    return { ok: true, summary: `Done: ${request.op} on control ${control.id}.${sent}`, untrusted: after ? pageText(after) : undefined };
  };

  const control = { controlId: { type: "string", description: "The control id from the last snapshot, for example \"0:12\"." } };
  return [
    {
      name: "snapshot",
      description: "Read the controls and the text of the current page. Call it before act or click.",
      parameters: { type: "object", properties: {} },
      scope: "read",
      domain: tabDomain,
      run: async () => {
        const page = await read(await options.tabId());
        return { ok: true, summary: `Read the page: ${page.controls.length} controls${page.more ? "; the page can scroll" : ""}.`, untrusted: pageText(page) };
      },
    },
    {
      name: "act",
      description: "Type into, select, check, uncheck, set a date on, or scroll one control from the last snapshot.",
      parameters: { type: "object", properties: { ...control, op: { type: "string", enum: [...OPS] }, value: { type: "string", maxLength: 2000 } }, required: ["controlId", "op"] },
      scope: "fill",
      domain: tabDomain,
      run: async (args) => operate(args, { op: args.op as ActRequest["op"], ...(typeof args.value === "string" ? { value: args.value } : {}) }),
    },
    {
      name: "click",
      description: "Click one control from the last snapshot. A click can send a form.",
      parameters: { type: "object", properties: control, required: ["controlId"] },
      scope: "submit",
      domain: tabDomain,
      run: async (args) => operate(args, { op: "click" }),
    },
    {
      name: "open_url",
      description: "Open an http or https address in the current tab.",
      parameters: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"] },
      scope: "read",
      domain: (args) => hostOf(String(args.url)),
      run: async (args, ctx: ToolContext) => {
        const tabId = await options.tabId();
        last = undefined;
        await api().tabs.update(tabId, { url: String(args.url) });
        for (let waited = 0; waited < LOAD_WAIT_MS && !ctx.signal.aborted; waited += 200) {
          await sleep(200);
          if ((await api().tabs.get(tabId)).status === "complete") break;
        }
        return { ok: true, summary: `Opened ${String(args.url)}. Call snapshot to read it.` };
      },
    },
    {
      name: "browser_task",
      description: "Let foxpaw fill and send a form on the current page from a goal such as \"email: sam@example.com, accept the terms, sign up\". foxpaw checks the result.",
      parameters: { type: "object", properties: { goal: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["goal"] },
      scope: "submit",
      domain: tabDomain,
      run: async (args, ctx: ToolContext) => {
        const tabId = await options.tabId();
        last = undefined;
        const result = await paw.runTask(tabId, String(args.goal), { browser: api(), signal: ctx.signal, ...(options.chooser ? { chooser: options.chooser } : {}) });
        const why = result.blockedReason ?? result.message;
        const summary = `foxpaw ${result.status}${why ? ` (${why})` : ""}; verified: ${result.verified}; ${result.steps.length} steps; ${result.unmatched.length} parts not matched.`;
        const check = { ok: result.verified, checks: result.checks, ...(result.problem ? { problem: result.problem } : {}) };
        const lines = result.checks.map((c) => `${c.ok ? "ok" : "not ok"}: ${c.part}: ${c.evidence}`).concat(result.unmatched.map((u) => `not matched: ${u}`));
        return { ok: result.status === "done", summary, untrusted: lines.join("\n"), check, data: result };
      },
    },
  ];
}
