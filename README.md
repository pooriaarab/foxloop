# foxloop

[![npm version](https://img.shields.io/npm/v/foxloop)](https://www.npmjs.com/package/foxloop)
[![Downloads per month](https://img.shields.io/npm/dm/foxloop)](https://www.npmjs.com/package/foxloop)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/foxloop) · [Quickstart](#run-your-first-agent-loop) · [API](#api) · [Issues](https://github.com/pooriaarab/foxloop/issues)

foxloop is an open-source TypeScript agent loop for developers who need gated tool calls, human approvals, and result checks.
It validates arguments, asks foxgate about each action, and streams run events.
Optional foxtrail logging records events before the loop continues.

## Install

```bash
npm install foxloop foxgate
```

Use Node.js 24 or later. foxloop has two direct runtime dependencies: foxgate and foxpaw.
Custom tools can run in Node.js. Browser tools require Firefox extension APIs.
No environment variables or credentials are needed for the scripted quickstart.
foxloop does not load `.env` files; pass model configuration through your planner.

## Run your first agent loop

Save this code as `example.mjs`, then run `node example.mjs`.
The planner has fixed replies, so this example needs no model server.

```js
import { createFoxgate } from "foxgate";
import { createLoop, scriptedMind, toolSpecs } from "foxloop";

const notes = [];
const tools = [
  {
    name: "save_note",
    description: "Save a note for the user.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    scope: "fill",
    domain: () => "notes.local",
    run: async ({ text }) => {
      notes.push(text);
      return { ok: true, summary: "Saved.", check: { ok: true, checks: [{ part: "note", ok: true, evidence: text }] } };
    },
  },
];

// The host keeps `host`. The loop gets only `gate`.
const { gate, host } = createFoxgate({ tools: toolSpecs(tools) });
await host.addGrant({ scope: "fill", domains: ["notes.local"] });

// A planner with fixed replies. Pass a foxmind Mind to use a real model.
const mind = scriptedMind([
  { calls: [{ name: "save_note", args: { text: "Buy milk" } }] },
  { calls: [{ name: "finish", args: { summary: "Saved the note." } }] },
]);

const loop = createLoop({ mind, gate, tools });
for await (const event of loop.run("Remind me to buy milk.")) {
  console.log(event.type, event.summary ?? event.decision ?? "");
}
console.log(notes);
```

Output:

```text
plan
tool-call
decision allow
tool-result Saved.
plan
check
done Saved the note.
[ 'Buy milk' ]
```

To use a real model, pass a [foxmind](https://github.com/pooriaarab/foxmind)
`Mind`. Its `chat` call has the shape that `createLoop` needs:

```js
import { createMind, ollama } from "foxmind";

const mind = createMind({ providers: [ollama({ model: "qwen3:0.6b" })], only: ["local"] });
```

In a Firefox extension, `browserTools` gives the loop a tab to work on. This
code runs in a background page that you bundle, for example with esbuild. The
extension needs the `scripting` permission and host access to the page.

```js
import { createFoxgate } from "foxgate";
import { browserTools, createLoop, toolSpecs } from "foxloop";

let tabId = 0;
const tools = browserTools({ tabId: () => tabId });
const { gate, host } = createFoxgate({ tools: toolSpecs(tools) });

async function run(tab, goal, mind, askHuman) {
  tabId = tab.id;
  const domain = new URL(tab.url).hostname;
  for (const scope of ["read", "fill", "submit"]) await host.addGrant({ scope, domains: [domain] });
  const onApproval = async (request) => ((await askHuman(request)) ? host.approve(request.requestId) : null);
  for await (const event of createLoop({ mind, gate, tools, onApproval }).run(goal)) console.log(event);
}
```

## How it works

```text
goal -> planner -> schema check -> foxgate -> approved action -> tool result
                                     | ask -> host approval -> redeem token
result -> next plan -> finish or host settle -> result check -> done / blocked
                     every event -> optional foxtrail append -> consumer
```

Tool definitions supply scope, domain, and payment metadata. The model supplies arguments subject to schema checks.
The loop executes `decision.action.args`, which are the arguments the gate judged.
Page text goes into escaped, nonce-delimited data blocks. This mechanism does not guarantee resistance to prompt injection.
The default completion check requires a passing check from the newest tool result.
A host-provided `settle` hook can also finish a run after a passing check.

## Why it exists

Browser actions need a host policy for domains, scopes, approvals, and completion checks.
foxloop connects those controls to an event-driven planner loop and a foxpaw browser tool pack.
[LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [Pydantic AI](https://ai.pydantic.dev/) provide broader agent frameworks.

## Compare

Checked 2026-10-14 against source and the linked framework documentation.

| Property | foxloop | LangChain | Pydantic AI |
|---|---|---|---|
| Main surface | Gated loop and Firefox tools | Configurable agent harness | Typed agent framework |
| Language | TypeScript | JavaScript / TypeScript in linked docs | Python |
| Configuration | Tools, planner, foxgate, checks | Models, tools, middleware | Agents, typed tools, dependencies |
| Execution | Your Node.js process or Firefox extension | Your application | Your Python application |

## Coverage

| Integration | Status | Role |
|---|---|---|
| foxgate | Implemented; runtime dependency | Action policy and approval token redemption |
| foxpaw / Mozilla Firefox | Implemented; runtime dependency | Seven browser tools inside an extension |
| foxmind | Optional interface integration | Planner `chat` replies |
| foxtrail | Optional interface integration | Append-only run event sink |

The demo registry has seven planner choices. These are demo adapters, not seven built-in library model clients.

| Demo planner | Status | Verification boundary |
|---|---|---|
| Scripted | Implemented | Fixed replies; no model |
| Ollama | Implemented via foxmind | Requires a running local model; extension origins must be allowed |
| llama.cpp llama-server | Implemented via foxmind | Local server required; no live run claimed here |
| Underdog Saluki 27B | Implemented via foxmind | No live model verification claimed here |
| OpenAI-compatible API | Implemented via foxmind | Own key and consent; live credentials unverified here |
| Anthropic | Implemented via foxmind | Own key and consent; live credentials unverified here |
| In-browser Qwen3-0.6B | Implemented via foxmind/browser | Model download required; no live model verification claimed here |

Source checks confirm all registry paths. Local tests use scripted planners, a real foxgate, and browser stand-ins.
This rewrite does not add real-model, real-browser, or credentialed provider verification.

## Common use cases

1. Firefox agent authors: connect foxpaw actions to foxgate approvals and a sidebar.
2. Form automation developers: preview a foxpaw form task and approve its destination.
3. Quality engineers: grant staging hosts and record run events through foxtrail.
4. Node.js developers: define custom tools and run a scripted planner before connecting foxmind.
5. Local model users: supply an Ollama planner and explicit completion checks.

## Features

- **Argument checks:** validates a fixed JSON Schema subset before policy checks.
- **Approvals:** exposes exact actions and redeems tokens from your host callback.
- **Budgets:** limits planner steps, tool calls, tokens, and elapsed time at loop checkpoints.
- **Batching:** defaults to four calls per turn and skips calls after failures or sending actions.
- **Events:** streams plans, decisions, results, checks, and terminal states.
- **Browser tools:** pins controls and form destinations before approved actions.

## Runtime surfaces

The library exports an async event iterator for Node.js and Firefox extension hosts.
It has no CLI or Model Context Protocol (MCP) server and exports no MCP tools.
`browserTools` returns seven tools; `askUserTool` adds a separate `ask_user` tool.
The internal `finish` tool requests a result check and is reserved.

### API

foxloop is a library. It has no CLI and no MCP server. The demo extension
shows it in Firefox.

### `createLoop(options)`

Returns a loop with one method, `run(goal, { signal })`. It returns an async
iterator of events. Stop reading to stop the run. One loop runs one goal at a
time; a second `run` throws `FoxloopError` `busy`.

| Option | Default | What it does |
|---|---|---|
| `mind` | required | `{ chat(messages, { tools, signal }) }` that returns `{ message, usage?, provider?, tier? }`. A foxmind `Mind` fits. |
| `gate` | required | The planner side of foxgate. Make it with `createFoxgate({ tools: toolSpecs(tools) })`. |
| `tools` | required | The tools the planner may call. See below. |
| `onApproval` | none | `(request) => Promise<string \| null>`. Show `request.action` and `request.detail` to the human. Return the token from `host.approve`, or `null` for no. With no `onApproval`, an `ask` stops the run. |
| `trail` | none | `{ append({ actor, kind, data }) }`. A foxtrail `Log` fits. Each event is one entry with the kind `loop.<event type>`. |
| `maxSteps` | 20 | The most model calls in one run. |
| `maxCallsPerTurn` | 4 | The most tool calls the loop runs from one model reply. Each call still gets its own gate check, approval and trail entries. After a failed call, a call that sends or pays, or a result with `stopBatch`, the rest of the reply is skipped: each skipped call gets a failed result with reason `skipped`. `1` keeps the "one tool at a time" prompt. |
| `firstRead` | none | A read tool with no required arguments, for example `"snapshot"`. It runs before the first model call when `gate.check` allows it; a deny, an ask or a tab with no page skips it. Its result goes in the history right after the goal. |
| `settle` | none | `({ goal, step, results, signal }) => Promise<string \| undefined>`. After a reply whose calls all ran and whose last result is ok, a fast host check ("is the goal reached?") that runs side by side with the next model call. A summary from it goes through `check`; when that passes before the model answers, the loop aborts the model call and ends `done` with `settled: true`. Otherwise the model's answer counts. |
| `budget` | none | `{ tokens?, toolCalls?, ms? }`. Tokens come from the model's usage, else from the text length divided by 4. The tool call budget is checked before the gate, so no human approves a call that the budget refuses. |
| `check` | the newest tool result's check | `({ goal, summary, lastCheck }) => CheckResult`. Decides if `finish` passes. |
| `now` | `Date.now` | The clock for the time budget. |
| `denials` | none | `{ retry, limit? }`. A `deny` at `gate.check` whose foxgate reason `retry(reason)` accepts goes back to the model as a failed result (`gate-deny`), and the run goes on. The `limit`-th such deny in a row (default 3) stops the run. A human's no and a deny at `gate.redeem` always stop the run. With no `denials`, every deny stops the run. |

### Events

| `type` | When | Fields |
|---|---|---|
| `plan` | The planner answered | `step`, `text`, `calls`, `provider`, `tier` |
| `tool-call` | A call is about to be checked | `id`, `name`, `args` |
| `decision` | The gate answered | `via` (`check` or `redeem`), `decision`, `reason`, `action` |
| `approval-needed` | The gate asks a human | `requestId`, `action`, `expiresAt`, `detail` |
| `tool-result` | A call ended | `name`, `ok`, `summary`, `reason` (`invalid-args`, `unknown-tool`, `tool-error`, `failed`, `gate-deny`, `skipped`), `detail` (a thrown error's message), `data` |
| `check` | The planner called `finish` | `ok`, `checks`, `problem` |
| `done` | The check passed | `summary`, `check` |
| `blocked` | The run stopped | `reason`, `message` |
| `aborted` | The signal aborted | `step` |

Block reasons: `max-steps`, `repeated-call` (the same call 3 times in a row),
`repeated-failure` (3 failed results in a row), `check-failed` (2 failed
checks), `model-error`, `gate-deny`, `gate-mismatch`, `gate-error`,
`approval-denied`, `approval-unavailable`, `approval-error`, `trail-failed`,
`budget`.

### Tools

A tool is a plain object:

| Field | What it does |
|---|---|
| `name` | 1-64 letters, digits, `_` or `-`. `finish` is reserved. |
| `description` | What the tool does, for the model. |
| `parameters` | A JSON Schema with `type: "object"`. foxloop checks `type`, `properties`, `required`, `additionalProperties`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `items`, `minItems` and `maxItems`. Any other rule keyword makes `createLoop` throw, so no rule is skipped. `additionalProperties` is `false` unless the schema sets it. |
| `scope` | `read`, `fill`, `submit` or `pay`, as in foxgate. |
| `amount(args)` | `{ value, currency }`. Needed for `pay`. |
| `domain(args, ctx)` | The host that the call touches. Throw to refuse the arguments. |
| `run(args, ctx)` | Does the work. `ctx.domain` is the domain that foxgate judged, and `ctx.signal` the abort signal. Returns `{ ok, summary, untrusted?, check?, data? }`. The model reads `summary` as trusted, so write it yourself; put any page text, and any error text that can quote a page, in `untrusted`. A thrown error's message goes to the model as data. |
| `prepare(args, ctx)` | Optional. Adds host-side arguments after the schema check and before the gate. foxgate judges the result, the human approves it, and `run` gets it. Throw to refuse the call. |
| `describe(args, ctx)` | Optional. Plain words for the approval, for example `click the button "Pay"`. It gets the prepared arguments. |

### `browserTools({ tabId, browser?, chooser?, paw?, passwords?, focus? })`

The browser tool pack, over [foxpaw](https://github.com/pooriaarab/foxpaw).
Tab tools take the domain from the tab address at the gate check. When the tab is on another host by the time the tool runs, the tool runs nothing.

`act`, `fill` and `click` pin their controls. Their `prepare` adds a `target` (for `fill`, one per field) with the
snapshot number, the control id, frame, node, guard, role, label, password flag and page
address. foxgate judges that `target`, and the human sees it in the exact
JSON. When the call runs, the tool acts only on that control from that
snapshot. If the page was read again in the meantime (for example by a
snapshot while the approval waited), or the control no longer matches, the
result is `stale` and nothing runs. Calls on one tab run one at a time.

`focus()` gives a text, such as the goal, for each page read. Then `snapshot` and `open_url` show the submit buttons and fields, the 20 controls that share the most words with it, and the 10 text lines that do, instead of the first 40 controls. Default: none.

`passwords(url)` is the one opt-in to type a password with `fill`. Give it only the passwords the user's own goal
names. `fill` and `fill_and_send` then type a value into a password field when the value is one of them, exactly;
`url` is the address of the field's own frame, and the field is read again just before its value is typed. The description shows the value as `•••`, and the result's data leaves it out. With no
`passwords`, `fill` refuses every password field.

| Tool | Scope | What it does |
|---|---|---|
| `snapshot` | `read` | Reads the page. The model gets up to 40 controls and the page text, all as untrusted data. A password field's value is never in it. |
| `act` | `fill` | Types, selects, checks, unchecks, sets a date or scrolls one control from the last snapshot, then reads the page again. |
| `fill` | `fill` | Sets up to 12 fields from the last snapshot in one call: `fields` maps each control id to text, an option, an ISO date, or `true`/`false` for a checkbox. It refuses a password field (unless `passwords` lists the exact value) and any control that only a click sets, acts on the pinned controls in order, stops at the first refusal, and reads the page once at the end. |
| `fill_and_send` | `submit` | Sets pinned fields, reads the page again, checks for drift, then clicks the pinned send button. |
| `click` | `submit` | Clicks one control from the last snapshot. A click can send a form, so foxgate asks by default. |
| `open_url` | `read` | Opens an `http:` or `https:` address in the tab, then reads the page when the tab is still on the judged host. The domain is the host of that address. |
| `browser_task` | `submit` | Reads the page and adds foxpaw's `preview` to the call as `form`: the destination, the send button and the fields, with sensitive values masked. Then runs foxpaw's `runTask` with the goal, pinned to that destination, and returns foxpaw's check. |

### `askUserTool({ ask, domain?, max? })`

The `ask_user` tool: the planner asks the user one short question (1 to 300
characters), the run waits on `ask(question, ctx)`, and the answer comes back
as the result, cut to 500 characters. It is a `read` tool on its own domain
(default `user.foxloop`), so grant that domain and the gate and the trail see
each question. Calls after it in the same reply are skipped. No answer, or a
throw, is a failed result and not a stop. A run asks at most `max` questions
(default 3).

### Other exports

| Export | What it does |
|---|---|
| `toolSpecs(tools)` | The foxgate tool registry for these tools: the same scope and amount function. |
| `defineTools(tools)` | Checks the tools. Throws `FoxloopError` `bad-tool` or `bad-schema`. |
| `checkArgs(schema, args)` | `null` when the arguments fit, else the path of the first error. |
| `scriptedMind(steps)` | A planner with fixed replies, for tests and offline demos. `seen` holds the messages of each call. |
| `plannerPrompt(options)`, `goalMessage(goal, nonce)`, `resultText(tool, output, nonce)`, `fitHistory(messages, nonce)`, `newNonce()`, `LIMITS` | The prompt and the result text. The system prompt holds no nonce, so a server can reuse its cached prefix across runs; the goal message gives the run's data marker. All the words the planner reads from foxloop are in `src/prompt.ts`. |
| `FoxloopError` | `code` is `bad-tool`, `bad-schema`, `bad-options` or `busy`. |

### Firefox APIs used

| API | MDN | Why |
|---|---|---|
| `scripting.executeScript` (through foxpaw) | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript) | The read and act steps run bundled functions in the page. |
| `tabs.get`, `tabs.update`, `tabs.query` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs) | Read the tab address for the domain, open a URL, find the tab. |
| Background scripts with `"type": "module"` (event page) | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts) | The demo hosts the loop, the gate host and the trail there. |
| `runtime.connect`, `runtime.sendMessage`, `runtime.onMessage` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime) | The sidebar streams events and sends approvals over a port. |
| `sidebarAction.toggle`, `sidebar_action`, `action.onClicked` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction) | The toolbar button opens the demo sidebar. |
| `storage.local`, `storage.session` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage) | Planner settings, and the API key in memory only. |
| `permissions.request` with `data_collection` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request) | Ask Firefox's consent before page text goes to a cloud key. |
| `browser_specific_settings.gecko.data_collection_permissions` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) | The demo collects nothing by default. `websiteContent` is optional, for the own-key planners. |
| `content_security_policy` with `'wasm-unsafe-eval'`, `unlimitedStorage` | [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy) | The in-browser model runs ONNX Runtime in WebAssembly and caches its files. |
| `crypto.getRandomValues` | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues) | A new nonce for the data delimiters in each run. |
| `AbortController`, `AbortSignal` | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) | Stop a run, also during a model call or a tool call. |

## Delivery and behavior limits

- The default run allows 20 planner calls and four calls per reply. Configure `maxSteps` and `maxCallsPerTurn` to change them.
- Three consecutive failed tool results or two failed completion checks stop the run.
- Repeated calls and repeating pairs of non-read calls can also stop a run.
- Budget checks run at loop checkpoints. They do not impose a hard timeout on an in-flight tool or model request.
- Abort signals request cancellation. Custom tools can continue after abort; late results can be recorded in the trail.
- Optional retryable gate denials stop after three consecutive denials by default. Human denials always stop.
- Supported JSON Schema keywords are listed above. Unsupported rule keywords fail tool registration.
- Host grants constrain actions, not the contents of data sent to an allowed host.
- Data delimiters do not prevent every prompt injection. Treat model answers as untrusted decisions.
- The default check needs the newest tool result's check. `snapshot`, `act`, `click`, and `open_url` provide none.
- Supply your own completion check for flows that end with those tools or `fill_and_send`.
- Run state stays in memory. Firefox can end a run when it unloads the background page.
- A `browser_task` approval covers the task's fields and clicks within the approved destination.
- `fill` and `fill_and_send` refuse passwords unless your `passwords(url)` callback supplies the exact value.
- A failed trail write stops continuation. Logging cannot undo an action already completed.
- Ollama extension calls require `OLLAMA_ORIGINS="moz-extension://*"`. The library does not configure that server.
- The demo requires opt-in and Firefox data permission for cloud planners. The core library does not enforce provider consent.

## Integration guides

- [Node.js scripted planner example](#run-your-first-agent-loop): run a tool and observe its completion check.
- [Firefox browser tool pack](#browsertools-tabid-browser-chooser-paw-passwords-focus-): scopes, control pinning, and form previews.
- [Host approvals](#createloopoptions): callbacks, tokens, logging, and budgets.
- [User questions](#askusertool-ask-domain-max-): grant and record the `ask_user` tool.

## Status

Version 0.1.17 is an early release. APIs can change before 1.0.
Use [GitHub issues](https://github.com/pooriaarab/foxloop/issues) for support.
Public case studies are not yet published in this repository.

### Demo extension

Build the bundled Firefox extension from a checkout:

```bash
pnpm install --frozen-lockfile
pnpm build:ext
```

Load `dist-ext/manifest.json` through `about:debugging#/runtime/this-firefox` in Firefox 153 or later.
Click the toolbar button to open the sidebar, choose a planner, enter a goal, and click Run.
The sidebar shows approval details and final checks. Demo grants cover the target host and end with the run.
Cloud planner keys stay in `storage.session`. Configure consent before sending page text.
Use this local build; the README does not promise AMO availability.

## FAQ

### What is foxloop?

foxloop runs a planner, validates tool arguments, checks actions through foxgate, and verifies completion.
It streams the run as events for your host application.

### Which integrations are verified?

foxloop implements foxgate, foxpaw, foxmind, and foxtrail connection paths.
The demo defines seven planner choices; this rewrite checks local tests without live model credentials.

### Does foxloop provide a managed agent service?

foxloop runs in your process or extension.
You supply model access, host policy, approval screens, and storage.

### How is foxloop different from LangChain?

foxloop focuses on a foxgate-controlled tool loop and Firefox tools.
LangChain provides a configurable agent harness with model, tool, and middleware composition.

### How is foxloop different from Pydantic AI?

foxloop is a TypeScript library with foxgate and foxpaw integration.
Pydantic AI provides a Python agent framework with typed tools and dependencies.

### Can I run foxloop without a model?

foxloop includes `scriptedMind` for fixed planner replies.
The quickstart uses it to run without credentials or network requests.

### Does a done event prove the task succeeded?

foxloop emits `done` after the configured completion check passes.
The check's quality depends on the evidence your tools and host provide.

### Does foxloop prevent prompt injection?

foxloop escapes outside text and places it in data delimiters.
Models can still follow injected text, so grants and host checks remain necessary.

### Does foxloop include an MCP server?

foxloop exposes a library event stream and tool helpers.
An MCP bridge requires a separate implementation.

## Development

```bash
pnpm install --frozen-lockfile
pnpm ci:local
pnpm e2e
pnpm e2e:ollama
```

The local gate runs library checks, extension build, web-ext lint, and AMO listing checks.
The extension lint excludes its browser-model bundle and ONNX Runtime files as configured by the repository.
Browser tests need Firefox. The Ollama test skips when its server is unavailable; a skip does not verify model behavior.

## License

[MIT](https://opensource.org/license/mit)
