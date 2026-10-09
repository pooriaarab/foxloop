// The E2E test: install the demo extension (dist-ext/) in a real Firefox,
// run goals through the real sidebar, background page, foxgate, foxtrail
// and foxpaw on the fixture pages in e2e/site, and write
// artifacts/e2e-<date>.json. The planner is the demo's scripted planner,
// so each run is the same.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary);
// FOXLOOP_SHOTS=<dir> also saves the rendered sidebar of each run as
// <dir>/<run>.html with its CSS, because BiDi cannot capture moz-extension:.
import { readFileSync, writeFileSync } from "node:fs";
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";

const record = { startedAt: new Date().toISOString(), checks: [], runs: {} };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });

const site = await serve("e2e/site");
let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const sidebar = await fox.openExtensionPage("sidebar.html");

  /** Saves the script, starts a goal on the tab at `path`, and answers each approval with `answer`. */
  async function run(name, path, goal, script, answer) {
    const page = await fox.open(`${site.url}/${path}`);
    await sidebar.evaluate(async (s) => browser.storage.local.set({ settings: { tier: "scripted", script: s } }), script ?? "");
    const before = (await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }))).entries.length;
    await sidebar.evaluate(async (url, g) => window.foxloopDemo.start(await window.foxloopDemo.tabFor(url), g), `${site.url}/${path}`, goal);
    const approvals = [];
    for (;;) {
      const state = await poll(sidebar, () => {
        const button = document.querySelector("li.ask button");
        const status = document.getElementById("status");
        if (button) return { ask: button.closest("li").querySelector("pre").textContent };
        return status.className ? { end: status.textContent, className: status.className } : null;
      }, undefined, 60_000);
      if (state.end) {
        const trail = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }));
        if (process.env.FOXLOOP_SHOTS) {
          const body = await sidebar.evaluate(() => document.body.innerHTML);
          writeFileSync(`${process.env.FOXLOOP_SHOTS}/${name}.html`, `<!doctype html><meta charset="utf-8"><style>${readFileSync("extension/sidebar.css", "utf8")}</style><body>${body}</body>`);
        }
        const events = await sidebar.evaluate(() => [...document.querySelectorAll("#events li")].map((li) => li.textContent));
        record.runs[name] = { goal, status: state.end, approvals, events, url: page.url(), trail: trail.entries.slice(before).map((e) => ({ kind: e.kind, data: e.data })), trailVerify: trail.verify };
        return { ...record.runs[name], className: state.className, kinds: trail.entries.slice(before).map((e) => e.kind), page };
      }
      approvals.push(JSON.parse(state.ask));
      await sidebar.evaluate((op) => document.querySelector(`li.ask button[data-op="${op}"]`).click(), answer);
    }
  }

  // E1: the default script: snapshot, browser_task with the goal, finish.
  const e1 = await run("form", "signup.html", "name: Sam Lee, email: sam@example.com, plan Team, accept the terms", "", "approve");
  check("form task done with one approval", { className: "done", approvals: 1, tool: "browser_task" }, { className: e1.className, approvals: e1.approvals.length, tool: e1.approvals[0]?.tool });
  check("form was sent", true, e1.url.includes("/welcome.html") && e1.url.includes("email=sam%40example.com"));
  check("foxpaw check passed", true, e1.trail.some((e) => e.kind === "loop.check" && e.data.ok === true));
  check("trail has the approval, both decisions and the stop", true,
    ["loop.approval-needed", "loop.decision", "loop.tool-result", "loop.done"].every((k) => e1.kinds.includes(k)) && e1.kinds.filter((k) => k === "loop.decision").length === 3);
  check("trail verifies", true, e1.trailVerify.ok);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.close();
  await site.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
