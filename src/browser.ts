// The browser tool pack: foxpaw's read, act and run-task calls as loop
// tools. Every page function is bundled in foxpaw; no tool runs model code.
import * as foxpaw from "foxpaw";
import type { ActRequest, Chooser, FormPlan, RunOptions, RunResult, ScriptingApi, Snapshot } from "foxpaw";
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
  preview: typeof foxpaw.preview;
  pageText: typeof foxpaw.pageText;
  changeText: typeof foxpaw.changeText;
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

const LOAD_WAIT_MS = 15_000;
const OPS = ["type", "select", "check", "uncheck", "date", "scroll"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The most fields one `fill` call sets (B21). */
const MAX_FIELDS = 12;
/** Controls that take true or false in `fill`, and the ones that take text (B16, B21). */
const BOOLEAN_ROLES = new Set(["checkbox", "switch", "radio", "option"]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** The page or the control is not the one the gate judged and the human approved. */
const stale = (why: string): ToolOutput => ({ ok: false, summary: `stale: ${why} after the call was checked. Nothing ran. Call snapshot, then ask again.` });

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

const readSummary = (page: Snapshot) => `Read the page: ${page.controls.length} controls${page.more ? "; the page can scroll" : ""}.`;

/** The page with every secret value masked, for page text. A secret value never goes to the model, even when a snapshot holds one (A4, B12). */
const masked = (page: Snapshot): Snapshot => ({ ...page, controls: page.controls.map((c) => (c.secret && c.value ? { ...c, value: "•••" } : c)) });

/** Why calls planned on `before` must not run on `after`: the address changed, or a control is gone or is another one (M4). */
function changed(before: Snapshot, after: Snapshot | undefined): string | undefined {
  if (!after) return "the page could not be read again";
  if (after.url !== before.url) return "the page address changed";
  const now = new Map(after.controls.map((c) => [c.id, c]));
  const moved = before.controls.some((c) => now.get(c.id)?.role !== c.role || now.get(c.id)?.label !== c.label);
  return moved ? "a control on the page is gone or changed" : undefined;
}

/** The control of `page` that `target` pinned, or undefined when it changed (B8). */
function pinned(page: Snapshot, target: Target) {
  const control = page.controls.find((c) => c.id === target.id);
  const same = control && control.guard === target.guard && control.label === target.label && control.role === target.role && control.node === target.node && control.frameId === target.frameId;
  return same ? control : undefined;
}

/**
 * Typed text and what the field shows, the same but for spaces or dashes between characters, when both are a card
 * number (digits only) or an IBAN (case ignored); else they must match exactly (B27).
 */
function sameGrouped(shown: string, typed: string): boolean {
  const a = ungrouped(shown);
  return a === ungrouped(typed) && (/^\d+$/.test(a) || /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(a));
}
function ungrouped(text: string): string {
  return text.trim().replace(/(?<=\w)[\s-]+(?=\w)/g, "").toUpperCase();
}
/** The host redacted this control's value in its reads (foxmate marks it when foxpass redacts it), B27. */
const redactedByHost = (c: Snapshot["controls"][number]) => (c as { redacted?: unknown }).redacted === true;

/** The control holds what its `fill` request gave: the same text, the same option, the box as asked (B24). */
function holds(c: Snapshot["controls"][number], request: ActRequest): boolean {
  if (request.op === "check" || request.op === "uncheck") return c.checked === (request.op === "check");
  if (request.op === "date") return c.value === request.value;
  // A field may group typed text (a card number in fours); the characters themselves must match (B26).
  if (request.op === "type") return c.value === request.value || sameGrouped(c.value, request.value ?? "");
  if (request.op === "select") return c.value === request.value || (c.options?.some((o) => o.selected && (o.value === request.value || o.label === request.value)) ?? false);
  return false;
}

/** A field whose value can be sent: not a button, a link or other click-only control. */
const isField = (c: Snapshot["controls"][number]) => !c.submit && (BOOLEAN_ROLES.has(c.role) || TEXT_ROLES.has(c.role) || c.tag === "select" || c.tag === "textarea");

/**
 * Why fill_and_send must not click: a filled field that does not hold its approved value, or another field that changed
 * since the approval snapshot (B26). A date or a suggestion pick may hold the page's own form of the value, as foxpaw read
 * it right after setting it; typed text and boxes must match exactly.
 */
function drift(before: Snapshot, now: Snapshot, targets: FillTarget[], seen: Map<string, string>): string | undefined {
  const given = new Map(targets.map((t) => [t.id, t.request]));
  const was = new Map(before.controls.map((c) => [c.id, c]));
  for (const c of now.controls) {
    if (!isField(c)) continue;
    const request = given.get(c.id);
    if (request) {
      const own = (request.op === "date" || request.op === "select") && seen.has(c.id) && c.value === seen.get(c.id);
      // The host redacts a card number or a code in every read: count the value foxpaw read right after typing it.
      const hidden = request.op === "type" && redactedByHost(c) && seen.has(c.id) && (seen.get(c.id) === request.value || sameGrouped(seen.get(c.id)!, request.value ?? ""));
      if (hidden) continue;
      if (!holds(c, request) && !own) return `field ${c.id} no longer holds the approved value`;
      continue;
    }
    const old = was.get(c.id);
    if (!old ? c.value !== "" || c.checked === true : old.value !== c.value || (old.checked ?? false) !== (c.checked ?? false)) return `field ${c.id} changed after the approval`;
  }
  return undefined;
}

/** A fill's change text with no line for a field that holds the value given (B24). */
function withoutGiven(text: string, after: Snapshot, targets: FillTarget[]): string {
  const given = new Set(targets.filter((t) => {
    const c = after.controls.find((a) => a.id === t.id);
    return c && !c.secret && holds(c, t.request);
  }).map((t) => `[${t.id}] `));
  if (!given.size) return text;
  const out: string[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (/^(Changed|New|Gone|New text|Acted on):$/.test(line)) section = line;
    if ((section === "Changed:" || section === "Acted on:") && [...given].some((g) => line.startsWith(g))) continue;
    out.push(line);
  }
  // A heading with no lines under it goes too.
  const kept = out.filter((line, i) => !(/^(Changed|Acted on):$/.test(line) && (i + 1 >= out.length || !out[i + 1]!.startsWith("["))));
  return [...kept, given.size === targets.length ? "Each field holds the value given." : `Fields that hold the value given: ${[...given].map((g) => g.slice(1, -2)).join(", ")}.`].join("\n");
}

/** The foxpaw request that sets `control` to `value` in `fill`. Throws for a control or a value that `fill` refuses (B15, B16, B21). */
function fillRequest(c: Snapshot["controls"][number], value: unknown): ActRequest {
  if (c.secret) throw new Error(`Control ${c.id} is a password field. fill does not type into one; use act.`);
  if (c.submit || !(BOOLEAN_ROLES.has(c.role) || TEXT_ROLES.has(c.role) || c.tag === "select" || c.tag === "textarea")) {
    throw new Error(`Control ${c.id} is a ${c.role}, not a field. fill sets fields only; use click.`);
  }
  if (BOOLEAN_ROLES.has(c.role)) {
    // "true", "false", or the control's own label, as a planner writes a radio ("One way") (B21).
    const said = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    if (said === "true" || (said && said === c.label.trim().toLowerCase())) value = true;
    else if (said === "false") value = false;
    if (typeof value !== "boolean") throw new Error(`Control ${c.id} is a ${c.role}: give true or false.`);
    if (c.role === "checkbox" || c.role === "switch") return { op: value ? "check" : "uncheck" };
    if (!value) throw new Error(`Control ${c.id} is a ${c.role}: give true to pick it.`);
    return { op: c.role === "radio" ? "check" : "select" };
  }
  if (typeof value !== "string" || value.length > 2000) throw new Error(`Control ${c.id} takes text of at most 2000 characters.`);
  if (c.tag === "select" || c.options?.length) return { op: "select", value };
  if (c.picker || c.type === "date") return { op: "date", value };
  // A field with a list of suggestions: foxpaw types the value and picks the one suggestion that holds it (B19).
  return { op: c.autocomplete ? "select" : "type", value };
}

/**
 * The browser tools: `snapshot`, `act`, `fill`, `click`, `open_url` and
 * `browser_task`. The domain of each call is the host of the tab address
 * (or of the address that `open_url` opens), read when the call runs.
 */
export function browserTools(options: BrowserToolsOptions): LoopTool[] {
  const paw: PawLike = options.paw ?? foxpaw;
  /** The page as text for the model. All of it comes from the page, so it is untrusted (P8). */
  const pageText = (page: Snapshot) => paw.pageText(masked(page));
  const api = () => options.browser ?? (globalThis as unknown as { browser: ScriptingApi & { tabs: TabsLike } }).browser;
  /** The newest snapshot. `generation` grows with each read, so an old approval can tell. */
  let last: { tabId: number; page: Snapshot; generation: number } | undefined;
  let generation = 0;
  /** One call at a time per tab: a read cannot slip in between another call's steps. */
  const queues = new Map<number, Promise<unknown>>();
  const serial = async <T>(fn: () => Promise<T>): Promise<T> => {
    const tabId = await options.tabId();
    const next = (queues.get(tabId) ?? Promise.resolve()).then(fn, fn);
    queues.set(tabId, next.catch(() => undefined));
    return next;
  };
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
    const page = await paw.snapshot(tabId, api());
    last = { tabId, page, generation: ++generation };
    return page;
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
  /** Pins the control the model named, so the gate judges and the human approves this exact control. */
  const targetOf = (c: Snapshot["controls"][number], url: string): Target =>
    ({ tabId: last?.tabId ?? -1, generation: last?.generation ?? -1, id: c.id, frameId: c.frameId, node: c.node, guard: c.guard, role: c.role, label: c.label, submit: c.submit, url });
  const pin = async (args: Record<string, unknown>) => {
    const { control: c, url } = await named(args);
    return { ...args, target: targetOf(c, url) };
  };
  /** Pins every field of a `fill` call, with its request. One bad field fails the whole call, before anything runs (B14-B17, B21). */
  const pinFields = async (args: Record<string, unknown>) => {
    const fields = Object.entries(args.fields as Record<string, unknown>);
    if (!fields.length) throw new Error("fields is empty. Give each control id and its value.");
    if (fields.length > MAX_FIELDS) throw new Error(`fill sets at most ${MAX_FIELDS} fields in one call.`);
    const targets: FillTarget[] = [];
    for (const [controlId, value] of fields) {
      const { control: c, url } = await named({ controlId });
      targets.push({ ...targetOf(c, url), request: fillRequest(c, value) });
    }
    return { ...args, targets };
  };
  /** Pins the fields as `fill` does and the button that sends, with its destination (B25). */
  const pinSend = async (args: Record<string, unknown>) => {
    const withFields = await pinFields(args);
    const { control: c, url } = await named({ controlId: args.send });
    if (c.role !== "button" || c.secret) throw new Error(`Control ${c.id} is a ${c.role}, not a button. send names the button that sends the form.`);
    if ((withFields.targets as FillTarget[]).some((t) => t.id === c.id)) throw new Error(`Control ${c.id} is the button; leave it out of fields.`);
    return { ...withFields, sendTarget: { ...targetOf(c, url), action: c.action ?? null } satisfies SendTarget };
  };
  const operate = async (args: Record<string, unknown>, request: ActRequest, signal: AbortSignal): Promise<ToolOutput> => {
    if (signal.aborted) return { ok: false, summary: "The run was aborted. Nothing ran." };
    const tabId = await options.tabId();
    const target = args.target as Target | undefined;
    if (!target) return { ok: false, summary: "The call has no pinned control. Nothing ran." };
    if (!last || last.tabId !== tabId || last.generation !== target.generation) return stale("the page was read again");
    const page = last.page;
    const control = pinned(page, target);
    if (!control) return stale("the control changed");
    if (signal.aborted) return { ok: false, summary: "The run was aborted. Nothing ran." };
    const result = await paw.act(tabId, control, request, page, api());
    if (!result.ok) {
      // Read the page again here, so the next reply can act without a snapshot call (B13).
      last = undefined;
      const detail = result.detail ? `Detail: ${result.detail}` : undefined;
      const now = await read(tabId).catch(() => undefined);
      if (!now) return { ok: false, summary: `foxpaw did not act: ${result.reason}. Call snapshot to read the page again.`, ...(detail ? { untrusted: detail } : {}) };
      const change = paw.changeText(masked(page), masked(now), { target: control.id });
      return { ok: false, summary: `foxpaw did not act: ${result.reason}. The page as it is now follows; plan from it.`, untrusted: [detail, change.text].filter(Boolean).join("\n") };
    }
    await paw.settle(tabId, { frameId: control.frameId }, api());
    const after = await read(tabId).catch(() => undefined);
    const sent = result.submitted ? " The form was sent." : "";
    // A diff on the same document; the full page after a navigation, a reload or a big change (B9-B11).
    const change = after ? paw.changeText(masked(page), masked(after), { target: control.id }) : undefined;
    const stopBatch = result.submitted ? "the form was sent" : changed(page, after) ?? (change?.full ? "the page changed" : undefined);
    return { ok: true, summary: `Done: ${request.op} on control ${control.id}.${sent}`, untrusted: change?.text, ...(stopBatch ? { stopBatch } : {}) };
  };

  /** Sets each pinned field on the snapshot the gate judged, then reads the page once (B17-B20, B22, B23). */
  const fillFields = async (args: Record<string, unknown>, signal: AbortSignal, seen?: Map<string, string>): Promise<ToolOutput> => {
    if (signal.aborted) return { ok: false, summary: "The run was aborted. Nothing ran." };
    const tabId = await options.tabId();
    const targets = args.targets as FillTarget[] | undefined;
    if (!targets?.length) return { ok: false, summary: "The call has no pinned fields. Nothing ran." };
    if (!last || last.tabId !== tabId || targets.some((t) => t.generation !== last!.generation)) return stale("the page was read again");
    const page = last.page;
    const controls = targets.map((t) => pinned(page, t));
    if (controls.some((c) => !c)) return stale("a control changed");
    const filled: { controlId: string; op: string; value?: string }[] = [];
    let refused: { id: string; reason: string; detail?: string } | undefined;
    let sent = false;
    let now = page;
    for (const [i, t] of targets.entries()) {
      if (signal.aborted) {
        refused = { id: t.id, reason: "the run was aborted" };
        break;
      }
      let control = controls[i]!;
      if (i > 0) {
        // foxpaw acts only on the page as last read, and a typed value changes it: read again, through
        // the snapshot hook, and find the same control. Its value or text around it may differ, so its
        // guard is the new one; its id, node, frame, role, label and destination must not (B22).
        last = undefined;
        const read2 = await read(tabId).catch(() => undefined);
        const same = read2?.controls.find((c) => c.id === control.id && c.node === control.node && c.frameId === control.frameId
          && c.role === control.role && c.label === control.label && c.submit === control.submit && c.action === control.action
          // A field that turned into a password field since the approval never gets a value meant to be seen (B15).
          && !c.secret);
        if (!read2 || !same || read2.url !== page.url) {
          refused = { id: t.id, reason: "stale", detail: read2 ? "the control changed after an earlier field" : "the page could not be read again" };
          break;
        }
        now = read2;
        control = same;
      }
      const result = await paw.act(tabId, control, t.request, now, api());
      if (!result.ok) {
        refused = { id: t.id, reason: result.reason ?? "refused", ...(result.detail ? { detail: result.detail } : {}) };
        break;
      }
      filled.push({ controlId: t.id, op: t.request.op, ...(t.request.value !== undefined ? { value: t.request.value } : {}) });
      if (result.value !== undefined) seen?.set(t.id, result.value);
      await paw.settle(tabId, { frameId: control.frameId }, api());
      // A field that sent the form: the rest would run on the next page (B20).
      if (result.submitted) {
        sent = true;
        break;
      }
    }
    // One read at the end, through the snapshot hook, so foxshield scans it (B22).
    last = undefined;
    const after = await read(tabId).catch(() => undefined);
    const lastId = filled.at(-1)?.controlId ?? refused?.id ?? targets[0]!.id;
    const change = after ? paw.changeText(masked(page), masked(after), { target: lastId }) : undefined;
    const done = filled.length ? `Filled: ${filled.map((f) => f.controlId).join(", ")}.` : "No field was filled.";
    const left = targets.slice(filled.length + (refused ? 1 : 0)).map((t) => t.id);
    const notDone = left.length ? ` Not done: ${left.join(", ")}.` : "";
    const data = { filled };
    if (refused) {
      const detail = refused.detail ? `Detail: ${refused.detail}` : undefined;
      const untrusted = [detail, change?.text].filter(Boolean).join("\n");
      const next = after ? "The page as it is now follows; plan from it." : "Call snapshot to read the page again.";
      return { ok: false, summary: `foxpaw did not act on control ${refused.id}: ${refused.reason}. ${done}${notDone} ${next}`, ...(untrusted ? { untrusted } : {}), data };
    }
    const stopBatch = sent ? "the form was sent" : changed(page, after) ?? (change?.full ? "the page changed" : undefined);
    const text = change && after && !change.full ? withoutGiven(change.text, after, targets) : change?.text;
    return { ok: true, summary: `Done: ${done}${sent ? " The form was sent." : ""}${notDone}`, untrusted: text, data, ...(stopBatch ? { stopBatch } : {}) };
  };

  /** The fields, a fresh read, then the pinned button, if it is still the same control with the same destination (B25). */
  const fillAndSend = async (args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> => {
    const before = last?.page;
    const seen = new Map<string, string>();
    const filled = await fillFields(args, signal, seen);
    const data = filled.data as { filled: unknown[] };
    if (!filled.ok) return { ...filled, summary: `${filled.summary} Nothing was sent.` };
    const send = args.sendTarget as SendTarget;
    const tabId = await options.tabId();
    const now = last?.tabId === tabId ? last.page : undefined;
    // Only a send, a new address or a control that went away or changed stops it; many fields that took their values do not.
    if (filled.stopBatch === "the form was sent") return { ...filled, summary: `${filled.summary} A field sent the form, so the button was not clicked.` };
    const why = before && now ? changed(before, now) ?? drift(before, now, args.targets as FillTarget[], seen) : "the page could not be read again";
    if (why) return { ...filled, ok: false, summary: `${filled.summary} Stopped: ${why}. Nothing was sent.` };
    const c = now?.url === send.url ? now.controls.find((x) => x.id === send.id && x.node === send.node && x.frameId === send.frameId && x.role === send.role
      && x.label === send.label && x.submit === send.submit && (x.action ?? null) === send.action) : undefined;
    if (!now || !c) return { ok: false, summary: `${filled.summary} The button changed after the fields. Nothing was sent.`, ...(filled.untrusted ? { untrusted: filled.untrusted } : {}), data };
    const click = await operate({ target: targetOf(c, now.url) }, { op: "click" }, signal);
    return { ...click, summary: `${filled.summary.replace(/^Done: /, "")} ${click.summary}`, data: { ...data, ...(click.ok ? { sent: send.id } : {}) } };
  };

  const control = { controlId: { type: "string", description: "The control id from the last snapshot, for example \"0:12\"." } };
  return [
    {
      name: "snapshot",
      description: "Read the controls and the text of the current page. Call it before act or click.",
      parameters: { type: "object", properties: {} },
      scope: "read",
      domain: tabDomain,
      run: (_args, ctx: ToolContext) => serial(async () => {
        const refused = await moved(ctx);
        if (refused) return refused;
        const tabId = await options.tabId();
        const before = last?.tabId === tabId ? last.page : undefined;
        const page = await read(tabId);
        // A read of the same page changes nothing, so [snapshot, act] runs on (M4).
        const stopBatch = before ? changed(before, page) : "the page was read for the first time";
        return { ok: true, summary: readSummary(page), untrusted: pageText(page), ...(stopBatch ? { stopBatch } : {}) };
      }),
    },
    {
      name: "act",
      description: "Type into, select, check, uncheck, set a date on, or scroll one control from the last snapshot.",
      parameters: { type: "object", properties: { ...control, op: { type: "string", enum: [...OPS] }, value: { type: "string", maxLength: 2000 } }, required: ["controlId", "op"] },
      scope: "fill",
      domain: tabDomain,
      prepare: pin,
      run: (args, ctx: ToolContext) => serial(async () => (await moved(ctx)) ?? operate(args, { op: args.op as ActRequest["op"], ...(typeof args.value === "string" ? { value: args.value } : {}) }, ctx.signal)),
      describe: (args) => {
        const t = args.target as Target;
        const value = typeof args.value === "string" ? ` "${args.value}"` : "";
        return `${String(args.op)}${value} ${args.op === "type" ? "into" : "on"} the ${t.role} "${t.label}" on ${t.url}`;
      },
    },
    {
      name: "fill",
      description: "Set several fields from the last snapshot in one call. fields maps each control id to its value: text, an option, an ISO date, or true/false for a checkbox.",
      parameters: { type: "object", properties: { fields: { type: "object", additionalProperties: true } }, required: ["fields"] },
      scope: "fill",
      domain: tabDomain,
      prepare: pinFields,
      run: (args, ctx: ToolContext) => serial(async () => (await moved(ctx)) ?? fillFields(args, ctx.signal)),
      describe: (args) => {
        const targets = args.targets as FillTarget[];
        const parts = targets.map((t) => `${t.request.op}${t.request.value !== undefined ? ` "${t.request.value}"` : ""} ${t.request.op === "type" ? "into" : "on"} the ${t.role} "${t.label}"`);
        return `fill ${targets.length} field${targets.length === 1 ? "" : "s"} on ${targets[0]?.url ?? "the page"}: ${parts.join("; ")}`;
      },
    },
    {
      name: "fill_and_send",
      description: "Set several fields from the last snapshot, then click the button that sends the form, in one call. fields as in fill; send is the button's control id.",
      parameters: { type: "object", properties: { fields: { type: "object", additionalProperties: true }, send: { type: "string" } }, required: ["fields", "send"] },
      scope: "submit",
      domain: tabDomain,
      prepare: pinSend,
      run: (args, ctx: ToolContext) => serial(async () => (await moved(ctx)) ?? fillAndSend(args, ctx.signal)),
      describe: (args) => {
        const targets = args.targets as FillTarget[];
        const send = args.sendTarget as SendTarget;
        const parts = targets.map((t) => `${t.request.op}${t.request.value !== undefined ? ` "${t.request.value}"` : ""} ${t.request.op === "type" ? "into" : "on"} the ${t.role} "${t.label}"`);
        return `fill ${targets.length} field${targets.length === 1 ? "" : "s"} on ${targets[0]?.url ?? "the page"}: ${parts.join("; ")}; then click the ${send.role} "${send.label}"${send.action ? ` (sends its form to ${send.action})` : send.submit ? " (sends its form)" : ""}`;
      },
    },
    {
      name: "click",
      description: "Click one control from the last snapshot. A click can send a form.",
      parameters: { type: "object", properties: control, required: ["controlId"] },
      scope: "submit",
      domain: tabDomain,
      prepare: pin,
      run: (args, ctx: ToolContext) => serial(async () => (await moved(ctx)) ?? operate(args, { op: "click" }, ctx.signal)),
      describe: (args) => {
        const t = args.target as Target;
        return `click the ${t.role} "${t.label}"${t.submit ? " (sends its form)" : ""} on ${t.url}`;
      },
    },
    {
      name: "open_url",
      description: "Open an http or https address in the current tab.",
      parameters: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"] },
      scope: "read",
      domain: (args) => hostOf(String(args.url)),
      run: (args, ctx: ToolContext) => serial(async () => {
        const tabId = await options.tabId();
        last = undefined;
        await api().tabs.update(tabId, { url: String(args.url) });
        for (let waited = 0; waited < LOAD_WAIT_MS && !ctx.signal.aborted; waited += 200) {
          await sleep(200);
          if ((await api().tabs.get(tabId)).status === "complete") break;
        }
        // Read the new page here, so the model needs no snapshot call (A1). Only on the judged host (A5).
        const refused = await moved(ctx);
        if (refused) return { ok: true, summary: `Opened ${String(args.url)}. ${refused.summary.replace(" Nothing ran.", "")} Call snapshot to read it.`, stopBatch: "the tab opened a new page" };
        const page = await read(tabId).catch(() => undefined);
        if (!page) return { ok: true, summary: `Opened ${String(args.url)}. The page read failed. Call snapshot to read it.`, stopBatch: "the tab opened a new page" };
        return { ok: true, summary: `Opened ${String(args.url)}. ${readSummary(page)}`, untrusted: pageText(page), stopBatch: "the tab opened a new page" };
      }),
    },
    {
      name: "browser_task",
      description: "Let foxpaw fill and send a form on the current page from a goal such as \"email: sam@example.com, accept the terms, sign up\". foxpaw checks the result.",
      parameters: { type: "object", properties: { goal: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["goal"] },
      scope: "submit",
      domain: tabDomain,
      // foxpaw's preview of the form: the gate judges and the human approves where it sends (G16).
      prepare: async (args) => serial(async () => {
        const page = await read(await options.tabId());
        const plan = await paw.preview(page, String(args.goal), options.chooser ? { chooser: options.chooser } : {});
        const form: TaskForm = { url: page.url, ...plan };
        return { ...args, form };
      }),
      describe: (args) => {
        const form = args.form as TaskForm | undefined;
        if (!form) throw new Error("The call has no form preview.");
        const fields = form.fields.map((f) => `${f.label}: ${JSON.stringify(f.value)}`).join("; ");
        const sends = form.destination ? `It sends to ${form.destination}${form.button ? ` with ${JSON.stringify(form.button)}` : ""}.` : form.sends ? "foxpaw found no destination to send to." : "It does not send the form.";
        return [
          `let foxpaw fill the form on ${form.url} for the goal "${String(args.goal)}".`, sends,
          fields ? `Fields: ${fields}.` : "",
          form.blocked ? `foxpaw expects to stop here: ${form.blocked}.` : "",
          `foxpaw picks each field and click itself${form.destination ? " and sends nowhere else" : ""}. This one approval covers all of them.`,
        ].filter(Boolean).join(" ");
      },
      run: (args, ctx: ToolContext) => serial(async () => {
        const refused = await moved(ctx);
        if (refused) return refused;
        const form = args.form as TaskForm | undefined;
        if (!form) return { ok: false, summary: "The call has no form preview, so no destination was approved. Nothing ran." };
        // The goal sends, and nothing names where to: there is no destination to approve (G17).
        if (form.sends && !form.destination) {
          return { ok: false, summary: "foxpaw found no destination for this form, so there is no destination to approve. Nothing ran.", ...(form.blocked ? { untrusted: `blocked: ${form.blocked}` } : {}) };
        }
        const tabId = await options.tabId();
        last = undefined;
        // The approved destination is the only one foxpaw may send to (foxpaw C32).
        const result = await paw.runTask(tabId, String(args.goal), {
          browser: api(), signal: ctx.signal, ...(options.chooser ? { chooser: options.chooser } : {}), ...(form.destination ? { allowHosts: [form.destination] } : {}),
        });
        // foxpaw's reason and message can quote the page, so they go with the untrusted lines.
        const summary = `foxpaw ${result.status}; verified: ${result.verified}; ${result.steps.length} steps; ${result.unmatched.length} parts not matched.`;
        const check = { ok: result.verified, checks: result.checks, ...(result.problem ? { problem: result.problem } : {}) };
        const why = [result.blockedReason && `blocked: ${result.blockedReason}`, result.message && `message: ${result.message}`].filter((line): line is string => Boolean(line));
        const lines = why.concat(result.checks.map((c) => `${c.ok ? "ok" : "not ok"}: ${c.part}: ${c.evidence}`).concat(result.unmatched.map((u) => `not matched: ${u}`)));
        return { ok: result.status === "done", summary, untrusted: lines.join("\n"), check, data: result };
      }),
    },
  ];
}

/** What a `browser_task` call fills and where it sends, as foxgate judges and the human approves it (G16). */
export interface TaskForm extends FormPlan {
  /** The page address the preview read. */
  url: string;
}

/** The button a `fill_and_send` call clicks, pinned with where its form sends (B25). */
interface SendTarget extends Target {
  action: string | null;
}

/** A field that a `fill` call is pinned to, and what foxpaw does to it (B17). */
interface FillTarget extends Target {
  request: ActRequest;
}

/** The control that an `act` or `click` call is pinned to, as foxgate judges and the human approves it. */
interface Target {
  tabId: number;
  /** The number of the snapshot the control came from. */
  generation: number;
  id: string;
  frameId: number;
  node: number;
  guard: string;
  role: string;
  label: string;
  submit: boolean;
  url: string;
}
