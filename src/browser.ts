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
  /** Why the tool must not run: the tab left the host that the gate judged. */
  const moved = async (ctx: ToolContext): Promise<ToolOutput | undefined> => {
    if (ctx.domain === undefined) return undefined;
    const host = await tabDomain().catch((error: Error) => error.message);
    return host === ctx.domain ? undefined : { ok: false, summary: `The tab is now on ${host}, not on ${ctx.domain} that the gate checked. Nothing ran.` };
  };
  const read = async (tabId: number) => {
    last = { tabId, page: await paw.snapshot(tabId, api()) };
    return last.page;
  };
  /** The control the args name, from a snapshot of the current tab. Throws when there is none. */
  const named = async (args: Record<string, unknown>) => {
    const tabId = await options.tabId();
    const page = last?.tabId === tabId ? last.page : undefined;
    if (!page) throw new Error("There is no snapshot of this page. Call snapshot first.");
    const found = page.controls.find((c) => c.id === args.controlId);
    if (!found) throw new Error(`No control has the id "${String(args.controlId)}" in the last snapshot.`);
    return { control: found, url: page.url };
  };
  const operate = async (args: Record<string, unknown>, request: ActRequest): Promise<ToolOutput> => {
    const tabId = await options.tabId();
    const page = last?.page;
    const found = await named(args).catch((error: Error) => error.message);
    if (typeof found === "string" || !page) return { ok: false, summary: `${found} Call snapshot to read the page.` };
    const { control } = found;
    const result = await paw.act(tabId, control, request, page, api());
    if (!result.ok) {
      last = undefined;
      return { ok: false, summary: `foxpaw did not act: ${result.reason}. Call snapshot to read the page again.`, ...(result.detail ? { untrusted: `Detail: ${result.detail}` } : {}) };
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
      run: async (_args, ctx: ToolContext) => {
        const refused = await moved(ctx);
        if (refused) return refused;
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
      run: async (args, ctx: ToolContext) => (await moved(ctx)) ?? operate(args, { op: args.op as ActRequest["op"], ...(typeof args.value === "string" ? { value: args.value } : {}) }),
      describe: async (args) => {
        const { control: c, url } = await named(args);
        const value = typeof args.value === "string" ? ` "${args.value}"` : "";
        return `${String(args.op)}${value} ${args.op === "type" ? "into" : "on"} the ${c.role} "${c.label}" on ${url}`;
      },
    },
    {
      name: "click",
      description: "Click one control from the last snapshot. A click can send a form.",
      parameters: { type: "object", properties: control, required: ["controlId"] },
      scope: "submit",
      domain: tabDomain,
      run: async (args, ctx: ToolContext) => (await moved(ctx)) ?? operate(args, { op: "click" }),
      describe: async (args) => {
        const { control: c, url } = await named(args);
        return `click the ${c.role} "${c.label}"${c.submit ? " (sends its form)" : ""} on ${url}`;
      },
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
      describe: async (args) => {
        const tab = await api().tabs.get(await options.tabId());
        return `let foxpaw fill the form on ${tab.url} for the goal "${String(args.goal)}". foxpaw picks each field and click itself and may send the form. This one approval covers all of them.`;
      },
      run: async (args, ctx: ToolContext) => {
        const refused = await moved(ctx);
        if (refused) return refused;
        const tabId = await options.tabId();
        last = undefined;
        const result = await paw.runTask(tabId, String(args.goal), { browser: api(), signal: ctx.signal, ...(options.chooser ? { chooser: options.chooser } : {}) });
        // foxpaw's reason and message can quote the page, so they go with the untrusted lines.
        const summary = `foxpaw ${result.status}; verified: ${result.verified}; ${result.steps.length} steps; ${result.unmatched.length} parts not matched.`;
        const check = { ok: result.verified, checks: result.checks, ...(result.problem ? { problem: result.problem } : {}) };
        const why = [result.blockedReason && `blocked: ${result.blockedReason}`, result.message && `message: ${result.message}`].filter((line): line is string => Boolean(line));
        const lines = why.concat(result.checks.map((c) => `${c.ok ? "ok" : "not ok"}: ${c.part}: ${c.evidence}`).concat(result.unmatched.map((u) => `not matched: ${u}`)));
        return { ok: result.status === "done", summary, untrusted: lines.join("\n"), check, data: result };
      },
    },
  ];
}
