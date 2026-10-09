// The demo's background page hosts the loop, the gate host and the trail.
// The sidebar talks to it over a "loop" port. The planner gets only the
// gate side of foxgate; approvals come from the human in the sidebar.
import { createFoxgate } from "foxgate";
import { Log, MemoryStore, generateKey } from "foxtrail";
import { browserTools, createLoop, toolSpecs } from "../src/index.ts";
import { mindFor } from "./mind.js";

let target = 0;
const tools = browserTools({ tabId: () => target });
const { gate, host } = createFoxgate({ tools: toolSpecs(tools) });
const trail = generateKey().then((key) => new Log({ store: new MemoryStore(), key }));
let busy = false;

browser.action.onClicked.addListener(() => browser.sidebarAction.toggle());

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.op !== "trail") return undefined;
  const log = await trail;
  return { entries: await log.entries(), verify: await log.verify() };
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "loop") return;
  const waiting = new Map();
  const early = new Map();
  let controller;
  const answer = (requestId, token) => {
    const resolve = waiting.get(requestId);
    waiting.delete(requestId);
    if (resolve) resolve(token);
    else early.set(requestId, token);
  };
  port.onMessage.addListener(async (message) => {
    if (message.op === "run") {
      controller = new AbortController();
      await run(port, message, controller.signal, (request) => new Promise((resolve) => {
        if (early.has(request.requestId)) resolve(early.get(request.requestId));
        else waiting.set(request.requestId, resolve);
      }));
    } else if (message.op === "approve") {
      answer(message.requestId, await host.approve(message.requestId).catch(() => null));
    } else if (message.op === "deny") {
      await host.reject(message.requestId).catch(() => undefined);
      answer(message.requestId, null);
    } else if (message.op === "stop") {
      controller?.abort();
    }
  });
  port.onDisconnect.addListener(() => {
    controller?.abort();
    for (const resolve of waiting.values()) resolve(null);
  });
});

/** Runs one goal on one tab. The grants cover that tab's host only, and end with the run. */
async function run(port, { goal, tabId, settings }, signal, onApproval) {
  const post = (message) => {
    try {
      port.postMessage(message);
    } catch {
      // The sidebar closed. onDisconnect aborts the run.
    }
  };
  if (busy) return post({ error: "A run is in progress." });
  busy = true;
  target = tabId;
  const grants = [];
  try {
    const domain = new URL((await browser.tabs.get(tabId)).url).hostname;
    for (const scope of ["read", "fill", "submit"]) grants.push(await host.addGrant({ scope, domains: [domain] }));
    const mind = await mindFor(settings ?? {}, goal);
    const loop = createLoop({ mind, gate, tools, trail: await trail, maxSteps: 12, budget: { ms: 10 * 60_000 }, onApproval });
    for await (const event of loop.run(goal, { signal })) {
      const text = event.type === "approval-needed" ? (await host.pending()).find((r) => r.id === event.requestId)?.text : undefined;
      post({ event: text ? { ...event, text } : event });
    }
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const grant of grants) await host.revokeGrant(grant.id);
    busy = false;
  }
  return undefined;
}
