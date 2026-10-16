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

/** B31: the script steps of one send on reply.html, and each finish check of a run: did B31 fail it? */
const send = (to) => [{ tool: "act", args: { controlId: "{{control:To}}", op: "type", value: to } }, { tool: "click", args: { controlId: "{{control:Send}}" } }];
const unconfirmed = (r) => r.trail.filter((e) => e.kind === "loop.check").map((e) => e.data.checks.some((c) => c.part === "the send went through" && !c.ok));

const site = await serve("e2e/site");
let fox;
try {
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const sidebar = await fox.openExtensionPage("sidebar.html");
  // E6: the tabs open before the first run. Each run must start and the test must end with this many.
  const baseline = (await fox.browser.pages()).length;
  const tabsAtStart = [];
  // The tab of the last run. Its checks read it, so the next run (or the end) closes it.
  let lastPage;
  const closeLastPage = async () => {
    await lastPage?.close();
    lastPage = undefined;
  };

  /** Saves the script, starts a goal on the tab at `path`, and answers each approval with `answer`. */
  async function run(name, path, goal, script, answer, settings = { tier: "scripted", script: script ?? "" }) {
    await closeLastPage();
    tabsAtStart.push((await fox.browser.pages()).length - baseline);
    const page = await fox.open(`${site.url}/${path}`);
    lastPage = page;
    await sidebar.evaluate(async (s) => {
      await browser.storage.local.set({ settings: s });
      await window.foxloopDemo.loadSettings();
    }, settings);
    const before = (await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }))).entries.length;
    await sidebar.evaluate(async (url, g) => window.foxloopDemo.start(await window.foxloopDemo.tabFor(url), g), `${site.url}/${path}`, goal);
    const approvals = [];
    for (;;) {
      const state = await poll(sidebar, () => {
        const button = document.querySelector("li.ask button");
        const status = document.getElementById("status");
        if (button) return { ask: button.closest("li").querySelector("pre").textContent, detail: button.closest("li").querySelector(".detail")?.textContent };
        return status.className ? { end: status.textContent, className: status.className } : null;
      }, undefined, 60_000);
      if (state.end) {
        const trail = await sidebar.evaluate(() => browser.runtime.sendMessage({ op: "trail" }));
        if (process.env.FOXLOOP_SHOTS) {
          const body = await sidebar.evaluate(() => {
            document.getElementById("goal").textContent = document.getElementById("goal").value;
            return document.body.innerHTML;
          });
          writeFileSync(`${process.env.FOXLOOP_SHOTS}/${name}.html`, `<!doctype html><meta charset="utf-8"><style>${readFileSync("extension/sidebar.css", "utf8")}</style><body>${body}</body>`);
        }
        const events = await sidebar.evaluate(() => [...document.querySelectorAll("#events li")].map((li) => li.textContent));
        record.runs[name] = { goal, status: state.end, approvals, events, url: page.url(), trail: trail.entries.slice(before).map((e) => ({ kind: e.kind, data: e.data })), trailVerify: trail.verify };
        return { ...record.runs[name], className: state.className, kinds: trail.entries.slice(before).map((e) => e.kind), page };
      }
      approvals.push({ ...JSON.parse(state.ask), detail: state.detail });
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

  // E2: the page tells the planner to open a link that sends data to another host.
  // The scripted planner obeys, as a naive model might. Grants cover 127.0.0.1 only.
  const linkScript = JSON.stringify([{ tool: "snapshot", args: {} }, { tool: "open_url", args: { url: "{{lastUrl}}" } }, { tool: "finish", args: { summary: "backed up" } }]);
  const e2 = await run("injected-link", "inject.html", "Read my profile and tell me my email.", linkScript, "approve");
  const first = e2.trail.find((e) => e.kind === "loop.decision");
  const opened = e2.trail.find((e) => e.kind === "loop.tool-call" && e.data.name === "open_url")?.data.args.url ?? "";
  check("injected link is denied", { blocked: true, decision: "deny", reason: "no-grant", host: "localhost", approvals: 0 },
    { blocked: e2.status.startsWith("Blocked (gate-deny)"), decision: e2.trail.filter((e) => e.kind === "loop.decision").at(-1)?.data.decision, reason: e2.trail.filter((e) => e.kind === "loop.decision").at(-1)?.data.reason, host: new URL(opened || "http://none").hostname, approvals: e2.approvals.length });
  check("the tab never left the page", true, e2.url.endsWith("/inject.html") && first?.data.decision === "allow");
  check("trail records the denied link", true, e2.kinds.at(-1) === "loop.blocked" && e2.trail.at(-1).data.reason === "gate-deny" && e2.trailVerify.ok);

  // E3: the page tells the planner to click its send button. The human denies the approval.
  const clickScript = JSON.stringify([{ tool: "snapshot", args: {} }, { tool: "click", args: { controlId: "{{control:Send my details}}" } }, { tool: "finish", args: { summary: "sent" } }]);
  const e3 = await run("injected-send", "inject.html", "Read my profile and tell me my email.", clickScript, "deny");
  check("injected send is refused", { blocked: "Blocked (approval-denied)", approvals: 1, tool: "click" },
    { blocked: e3.status.slice(0, 25), approvals: e3.approvals.length, tool: e3.approvals[0]?.tool });
  check("the approval names the button", `click the button "Send my details to our partner" (sends its form) on ${site.url}/inject.html`, e3.approvals[0]?.detail);
  check("nothing was sent", "", await e3.page.evaluate(() => document.getElementById("sent").textContent));
  check("trail records the refusal", true, e3.kinds.includes("loop.approval-needed") && e3.trail.at(-1).data.reason === "approval-denied" && e3.trailVerify.ok);

  // B31: a send whose form comes back with a new error is unconfirmed: its check fails, with what to fix. The page keeps
  // a maintenance alert from before every send, and a good send draws the same form again, empty: that send is not
  // failed by B31. (The demo has no result check of its own for a click, so its finish after a good click still says
  // "nothing checked the result"; foxmate's own check takes over there.)
  const replyScript = JSON.stringify([{ tool: "snapshot", args: {} }, ...send("Dana Lee <dana>"), { tool: "finish", args: { summary: "Replied" } },
    ...send("dana.lee@example.com"), { tool: "finish", args: { summary: "Replied" } }]);
  const b31 = await run("unconfirmed-send", "reply.html", "Reply to Dana and say it is approved.", replyScript, "approve");
  check("a send that came back with an error fails its finish; the fixed send is not failed by B31", { unconfirmed: [true, false], sent: "Sent to dana.lee@example.com." },
    { unconfirmed: unconfirmed(b31), sent: await b31.page.evaluate(() => document.getElementById("sent").textContent) });
  check("the failed finish says what to fix", "the form came back: read it for the error, then send again", b31.trail.find((e) => e.kind === "loop.check")?.data.problem);
  const goodScript = JSON.stringify([{ tool: "snapshot", args: {} }, ...send("dana.lee@example.com"), { tool: "finish", args: { summary: "Replied" } }]);
  const good = await run("good-send-redrawn", "reply.html", "Reply to Dana and say it is approved.", goodScript, "approve");
  check("a good send that draws the form again, under a standing alert, is not failed by B31", [false], unconfirmed(good));

  // B8: an approved click acts on the control that the human approved, pinned in the gate's action.
  const nextScript = JSON.stringify([{ tool: "snapshot", args: {} }, { tool: "click", args: { controlId: "{{control:Next}}" } }, { tool: "finish", args: { summary: "next" } }, { tool: "finish", args: { summary: "next" } }]);
  const b8 = await run("approved-click", "steps.html", "Go to the next step.", nextScript, "approve");
  check("approved click lands on the captured control", { label: "Next", clicked: "next clicked", ok: true },
    { label: b8.approvals[0]?.args?.target?.label, clicked: await b8.page.evaluate(() => document.getElementById("done").textContent),
      ok: b8.trail.some((e) => e.kind === "loop.tool-result" && e.data.name === "click" && e.data.ok) });

  // Settings: every planner tier is offered, and each shows only its fields.
  await sidebar.evaluate(() => location.reload());
  await new Promise((resolve) => setTimeout(resolve, 500));
  const tiers = await poll(sidebar, () => document.querySelectorAll("#tier option").length && [...document.querySelectorAll("#tier option")].map((o) => o.value));
  check("settings offer every planner tier", ["scripted", "ollama", "llama-server", "saluki", "openai", "anthropic", "browser"], tiers);
  const fields = await sidebar.evaluate(() => {
    const tier = document.getElementById("tier");
    tier.value = "openai";
    tier.dispatchEvent(new Event("change", { bubbles: true }));
    return [...document.querySelectorAll("[data-for]")].filter((d) => !d.hidden).map((d) => d.querySelector("input, textarea").id);
  });
  check("the own-key tier shows model, base URL and key", ["model", "base-url", "api-key"], fields);
  const cloud = await run("no-consent", "signup.html", "email: sam@example.com", "", "deny", { tier: "openai", model: "x", consent: false });
  check("a cloud tier needs consent before page text leaves", true, cloud.status.includes("Allow sending page text"));
  const ticked = await run("box-but-no-grant", "signup.html", "email: sam@example.com", "", "deny", { tier: "openai", model: "x", consent: true });
  check("a ticked box without Firefox's data consent is not enough", true, ticked.status.includes("Allow sending page text"));

  const cloudModel = await run("ollama-cloud-model", "signup.html", "email: sam@example.com", "", "deny", { tier: "ollama", model: "gpt-oss:120b-cloud" });
  check("private mode refuses an Ollama cloud model", true, cloudModel.status.includes("runs on Ollama's servers"));

  // A real model tier from the extension: Ollama refuses moz-extension: origins unless
  // OLLAMA_ORIGINS allows them, and CI has no Ollama. Either way the run must stop with a clear error.
  const local = await run("ollama-from-extension", "signup.html", "email: sam@example.com", "", "deny", { tier: "ollama", model: "qwen3:0.6b" });
  check("a model tier that cannot answer stops with model-error", true, local.status.startsWith("Blocked (model-error)"));

  // E6: on Ichabod a session slows with each open tab, so no run may leave its tab behind.
  await closeLastPage();
  check("every run closes its tab", { atStart: tabsAtStart.map(() => 0), atEnd: 0 }, { atStart: tabsAtStart, atEnd: (await fox.browser.pages()).length - baseline });
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  const pages = await fox?.browser.pages().catch(() => []);
  record.sidebarAtError = await pages?.find((p) => p.url().endsWith("sidebar.html"))?.evaluate(() => document.body.innerText).catch(() => undefined);
} finally {
  await fox?.close();
  await site.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${JSON.stringify(c.actual)}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
