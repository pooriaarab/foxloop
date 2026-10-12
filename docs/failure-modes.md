# Failure modes

This file lists every way foxloop can fail that we know of. Each row names the
behaviour we want and the test that checks it. We wrote this list first, then
the tests, then the code.

- **E2E** checks run in a real Firefox through `pnpm e2e` (`e2e/run.mjs`).
- **Isolated** tests run in Node through `pnpm test` (`tests/*.test.ts`). They
  use `scriptedMind`, a fake planner that returns fixed replies, so each run
  is the same.

A **stop** ends the run with one event: `done`, `blocked` (with a `reason`),
or `aborted`. No tool runs after a stop.

## Tool registry and arguments

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| R1 | A tool has a bad name, a name that another tool has, or the reserved name `finish`. The model cannot call it, or calls the wrong one. | `createLoop` throws `FoxloopError` with code `bad-tool`. | Isolated `tests/tools.test.ts` |
| R2 | A tool schema uses a JSON Schema keyword that the validator does not check (for example `oneOf`). The validator lets bad arguments through. | `createLoop` throws `bad-schema` and names the keyword. | Isolated `tests/tools.test.ts` |
| R3 | A tool has no scope, a scope that foxgate does not know, or the scope `pay` with no `amount` function. | `createLoop` throws `bad-tool`. | Isolated `tests/tools.test.ts` |
| R4 | The model writes arguments of the wrong type, leaves out a required one, or adds one the schema does not name. | The tool does not run and the gate does not see the call. The result is `invalid-args` with the path of the first error. The model sees it and can try again. | Isolated `tests/tools.test.ts`, `tests/loop.test.ts` |
| R5 | The model puts `scope`, `amount` or `domain` in its arguments to change what the gate judges. | Extra arguments are refused (R4), because `additionalProperties` is `false` when the schema does not set it. The scope, the amount and the domain always come from the host's tool. | Isolated `tests/loop.test.ts` |
| R6 | The model asks for a tool that does not exist. | Nothing runs. The result is `unknown-tool` with the list of tool names. | Isolated `tests/loop.test.ts` |
| R7 | The model writes code and asks the loop to run it. | The loop has no tool that runs code. A tool gets JSON arguments only. The browser tools call bundled foxpaw functions. | Isolated `tests/loop.test.ts` (no `eval` path), E2E |

## The loop

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| L1 | The model never calls `finish`. The loop runs forever. | After `maxSteps` model calls, the run stops with `blocked` `max-steps`. | Isolated `tests/loop.test.ts` |
| L2 | The model asks for the same call with the same arguments again and again. | The third same call in a row stops the run with `blocked` `repeated-call`. | Isolated `tests/loop.test.ts` |
| L3 | Calls fail again and again (bad arguments, unknown tool, tool error). | After 3 failed results in a row, the run stops with `blocked` `repeated-failure`. | Isolated `tests/loop.test.ts` |
| L4 | A tool throws. | The error message (cut to 500 characters) goes back to the model as a failed result with `tool-error`. It counts toward L3. | Isolated `tests/loop.test.ts` |
| L5 | The model says it is done, but the result is wrong. | The loop runs the check. A failed check goes back to the model. After 2 failed checks, the run stops with `blocked` `check-failed`. | Isolated `tests/loop.test.ts` |
| L6 | The model says it is done, but no tool result can show it. | The default check fails with "nothing checked the result". | Isolated `tests/loop.test.ts` |
| L14 | An early tool returns a passing check, then a later tool fails (for example a payment). The model calls `finish`, and the run ends `done` on the old check. | Every tool result clears the old check: a failed result, a thrown tool, an invalid or unknown call, or a result with no check. Only the newest tool result's check counts. | Isolated `tests/loop.test.ts` |
| L7 | The run uses more tokens, tool calls or time than the budget. | Before each model call and each tool call, the loop compares the totals with `budget`. Over the budget, it stops with `blocked` `budget`. | Isolated `tests/loop.test.ts` |
| L8 | The user aborts during a model call. | The signal goes to `mind.chat`. The run stops with `aborted`. No tool runs. | Isolated `tests/loop.test.ts` |
| L9 | The user aborts during a tool call, and the tool ignores the signal. | The run stops with `aborted` at once. The late result does not go to the model. | Isolated `tests/loop.test.ts` |
| L15 | The abort comes while an approved click runs. The run ends `aborted`, but the click still lands, and the trail never shows it. | Tools get the signal. `act` and `click` check it before they act. When a tool ends after the abort, the loop appends its result to the trail as `loop.late-result`. | Isolated `tests/stops.test.ts`, `tests/browser.test.ts` |
| L16 | The tool call budget is used up, but the loop still asks the human to approve the next call, then refuses it. | The tool call budget is checked before the gate and before any approval. | Isolated `tests/stops.test.ts` |
| L10 | The model call fails (server down, bad reply). | The run stops with `blocked` `model-error`. The loop does not retry. | Isolated `tests/loop.test.ts` |
| L11 | A tool returns a very long result. The model context fills up. | The summary is cut to 2,000 characters and page text to 4,000. When the history is over 24,000 characters, page text is dropped from the history (L17-L21). | Isolated `tests/prompt.test.ts` |
| L17 | The trim cuts one more old message at each step, so the cut point moves every step. A model that reuses only an exact prompt prefix (a hybrid model on llama-server) misses its cache at every step and reads ~7k tokens again (77-108 s per call, seen on foxbench). | The trim runs only when the history goes over the limit. Then it drops the page text of every tool message except the newest in one step, and the loop keeps the trimmed history. Text that was dropped never comes back. Between two trims the history only grows at the end, so the prefix up to the last trim point is byte-identical from step to step. | Isolated `tests/prompt.test.ts`, `tests/loop.test.ts` |
| L18 | The trim drops the page text of the newest result, so the model cannot read what it just asked for. | The newest tool message is never cut. | Isolated `tests/prompt.test.ts` |
| L19 | The trim removes or reorders a message, so a `tool_calls` entry loses its `tool` result and the API refuses the history. | The trim changes only the page text in `tool` messages. It keeps every message, its order, its role, its `tool_call_id` and its `tool_calls`. Messages with no page text stay byte-identical. | Isolated `tests/prompt.test.ts` |
| L20 | A cut message loses its data fence, so page text, or a part of it, is outside the delimiters and reads as instructions. | A cut message keeps the status, the summary and both nonce markers. Between them it holds only "[page text dropped to save space; call snapshot to read it again]". A message whose fence is not whole is not cut. | Isolated `tests/prompt.test.ts` |
| L21 | The history stays near the limit, so it goes over again at the next step and the trim runs at almost every step (the cache misses of L17 again). | One trim takes the history down to about half the limit when the summaries are small. So across a run the number of trims is about (page text added) / (limit / 2), not one per step. | Isolated `tests/loop.test.ts` |
| L12 | The caller stops reading events (`break`). The loop keeps acting in the background. | The loop stops at the next step. No more tools run. | Isolated `tests/loop.test.ts` |
| L13 | The caller starts a second run on the same loop while one runs. Two runs share the history. | The second `run` throws `busy`. | Isolated `tests/loop.test.ts` |

## Several calls in one reply

With `maxCallsPerTurn` above 1 (default 4), the model may ask for several
tool calls in one reply, so a task needs fewer model calls. A "batch" is the
calls of one reply. A "skip" is a call of the batch that does not run.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | A batch skips an approval: the second `ask` call of a batch runs on the first call's approval. | Each call goes through `gate.check` on its own, and each `ask` gets its own `approval-needed` event, its own `onApproval` call and its own `gate.redeem`. | Isolated `tests/batch.test.ts` |
| M2 | A batch merges approvals: one approval request lists, or one token covers, two actions. | Each `onApproval` request holds one action. A token redeems one action only (foxgate), so a token used for call 1 cannot run call 2. | Isolated `tests/batch.test.ts` |
| M3 | A call that sends or pays is not last. Later calls run on the page after the send, which the model never saw. | After a call whose tool scope, or whose judged scope, is `submit` or `pay`, the rest of the batch is skipped. | Isolated `tests/batch.test.ts` |
| M4 | Calls after a navigation run on the wrong page: `open_url` reads the new page, and the next `click` pins control "0:12" of a page the model never saw. | A tool result can carry `stopBatch`. `open_url` always sets it. `act` sets it when the address changed or a control of the page before is gone or has another role or label. `snapshot` sets it when it is the first read of the tab or the page changed since the last read. The rest of the batch is skipped. Known gap: `changed` does not see new controls, such as a modal that covers the page. | Isolated `tests/batch.test.ts`, `tests/browser.test.ts` |
| M9 | Three identical calls in one reply (three scrolls) hit the L2 repeat limit with no model turn between. | Identical calls in one reply count once toward L2. | Isolated `tests/batch.test.ts` |
| M5 | A call fails, or the gate denies it (G12), and the calls after it still run on a plan that no longer holds. | After a failed result (any reason), the rest of the batch is skipped. | Isolated `tests/batch.test.ts` |
| M6 | A skipped call is reported as done, or gets no result. The model thinks it ran, or the API refuses a `tool_calls` entry with no `tool` message. | Each skipped call gets a `tool` message and a `tool-result` event with `ok: false` and reason `skipped`. The text names the calls that ran and says this one did not run. A skip does not count toward L3 and does not change the last check (L14). | Isolated `tests/batch.test.ts` |
| M7 | The model asks for more calls than the cap, or `finish` before other calls. | Calls past `maxCallsPerTurn` are skipped. `finish` ends the batch, and it is skipped when the batch ended before it. | Isolated `tests/batch.test.ts` |
| M8 | The prompt still says "one tool at a time", or does not say which calls must be last. | With a cap above 1, rule 1 gives the cap, says that calls run in order, names the tools that send or pay, and says that a failure or a page change skips the rest. With a cap of 1, rule 1 does not change. | Isolated `tests/prompt.test.ts` |

## Page read with no model call

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| A1 | Two model calls per task only read the page: one at the start, one after `open_url`. | With `firstRead: "snapshot"`, the loop runs that tool before the first model call and adds its call and result to the history. `open_url` reads the new page and returns it. | Isolated `tests/batch.test.ts`, `tests/browser.test.ts` |
| A2 | The first read skips the gate, or a deny or an ask at the first read stops the run or asks the human. | The first read goes through `gate.check`, and the trail gets its events. Only `allow` runs it. A deny, an ask, or a tab with no web page skips the read, and the run goes on. | Isolated `tests/batch.test.ts` |
| A3 | The read puts page text outside the data fence. | The page text goes only in the `untrusted` part, between the nonce markers, cut to 4,000 characters (L11). Summaries hold only text that foxloop writes. | Isolated `tests/batch.test.ts`, `tests/browser.test.ts` |
| A4 | The read on a sign-in wall puts a password value into the page text. | The read uses the same `paw.snapshot` as `snapshot`, so the host's foxshield and foxpass wrappers apply. The page text never holds the value of a `secret` control. | Isolated `tests/browser.test.ts` |
| A5 | `open_url` is sent to another host (a redirect), and the read gives the model a page on a host that the gate never judged. | `open_url` reads only when the tab host is the judged domain. Else its result says where the tab is and holds no page text. | Isolated `tests/browser.test.ts` |
| A6 | The first read breaks the stable history (L17): it goes in the system prompt, or in front of older messages. | The read is an assistant call and a `tool` message right after the goal. The trim can cut its page text as for any other result. | Isolated `tests/batch.test.ts` |
| A7 | `firstRead` names a tool that does not exist, is not a read, or needs arguments. | `createLoop` throws `bad-options`. | Isolated `tests/batch.test.ts` |

## Ask the user

`askUserTool({ ask })` gives the planner one tool, `ask_user`. It shows one
short question to the user, waits, and gives the answer back as the result.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| U1 | The planner guesses a detail that only the user knows (a size, an OK to spend more than the goal allows, a sign-in), and acts on the guess. | `ask_user` sends the question to the host's `ask` and waits. The answer comes back as the result summary, as words from the user. | Isolated `tests/ask.test.ts` |
| U2 | The planner plans more calls after `ask_user` in the same reply. They run before the answer is in, on a plan the answer can change. | The result of `ask_user` carries `stopBatch`, so the rest of the reply is skipped (M4, M6). | Isolated `tests/ask.test.ts` |
| U3 | The question is empty, or very long, so the user gets nothing to answer or a wall of text. | The schema needs 1 to 300 characters. Other arguments never reach the host (R4). | Isolated `tests/ask.test.ts` |
| U4 | The user does not answer, closes the question, or `ask` throws. The run waits forever, or stops with an error. | An empty answer, `undefined` or a throw is a failed result that says the user did not answer. The planner goes on with what it knows. A throw is not a stop. | Isolated `tests/ask.test.ts` |
| U5 | The user stops the run while the question waits. | `ask` gets the run's signal. The loop ends `aborted` at once (L9), also when `ask` ignores the signal. | Isolated `tests/ask.test.ts` |
| U6 | The planner asks again and again in place of acting, and each question holds the user. | After `max` questions in one run (default 3), `ask_user` fails without asking, and says to act on what the planner knows. The count starts again at each run. | Isolated `tests/ask.test.ts` |
| U7 | A long answer fills the context. | The answer is cut to 500 characters. | Isolated `tests/ask.test.ts` |
| U8 | The answer holds a data marker or angle brackets, and closes a data block. | The answer is in the summary, and every `<` and `>` in a summary is escaped (P5). | Isolated `tests/ask.test.ts` |
| U9 | `ask_user` skips the gate, so a host cannot turn questions off or log them. | `ask_user` is a `read` tool on its own domain (default `user.foxloop`). The host grants that domain, and the gate and the trail see each question. | Isolated `tests/ask.test.ts` |

## Gate and approval

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| G1 | A tool runs without a gate check. | Every call goes through `gate.check`. The tool runs with `decision.action.args`, the action that foxgate judged, not the model's copy. | Isolated `tests/approval.test.ts` |
| G2 | The gate allows an action for another tool. | The run stops with `blocked` `gate-mismatch`. Nothing runs. | Isolated `tests/approval.test.ts` |
| G3 | The gate says `deny`. | Nothing runs. The run stops with `blocked` `gate-deny` and the foxgate reason. | Isolated `tests/approval.test.ts`, E2E `injected link is denied` |
| G4 | The gate says `ask`, and the human says no. | `onApproval` returns `null`. Nothing runs. The run stops with `blocked` `approval-denied`. | Isolated `tests/approval.test.ts`, E2E `injected send is refused` |
| G5 | The gate says `ask`, and the app gave no `onApproval`. | The run stops with `blocked` `approval-unavailable`. | Isolated `tests/approval.test.ts` |
| G6 | `onApproval` returns a token that was used before, or a bad token. | `gate.redeem` says `deny`. Nothing runs. The run stops with `blocked` `gate-deny`. | Isolated `tests/approval.test.ts` |
| G7 | `onApproval` throws. | The run stops with `blocked` `approval-error`. Nothing runs. | Isolated `tests/approval.test.ts` |
| G8 | `gate.check` or `gate.redeem` throws. | The run stops with `blocked` `gate-error`. Nothing runs. | Isolated `tests/approval.test.ts` |
| G10 | The approval shows only an opaque argument, such as `controlId: "0:1"`. The human cannot tell what they approve. | A tool can have `describe(args)`. Its text goes into `approval-needed` and the `onApproval` request as `detail`. The browser tools name the control's role and label and the page address. If `describe` throws, the run stops with `approval-error` and nothing runs. | Isolated `tests/approval.test.ts`, `tests/browser.test.ts`, E2E `injected send is refused` |
| G11 | The approval for `browser_task` shows only `{ goal }`. The human cannot tell that it covers many fields and clicks, and a send, on one page. | `browser_task` describes the page address, the goal, and that foxpaw picks each field and click and may send the form. | Isolated `tests/browser.test.ts` |
| G16 | The approval for `browser_task` names the goal but not where the form sends or which fields get a value. A look-alike form on the page, or a form that posts to another path, gets the human's yes for data they never saw leave (foxpaw C30). | `prepare` reads the page and adds foxpaw's `preview` as `form`: the page address, whether the goal sends, the destination (the action URL), the send button, and each field's label and value, with sensitive values masked. foxgate judges and the human approves that. `describe` says "It sends to <destination>" and lists the fields. When foxpaw would stop on this page, it says so. | Isolated `tests/browser.test.ts` |
| G17 | The human approves one destination, and foxpaw sends somewhere else: a script moves the form's action after the approval, a second form appears, or the page sends to a sibling path that foxpaw's own rule (C24) accepts. | `run` passes the approved destination to `runTask` as the only `allowHosts` URL entry, so foxpaw refuses every other destination (foxpaw C32). When the goal sends and the preview found no destination (fields outside a form, or foxpaw would stop), nothing runs: there is no destination to approve. A call with no `form` from `prepare` runs nothing. | Isolated `tests/browser.test.ts` |
| G9 | The tool's `domain` function throws (for example `open_url` gets `javascript:`). | Nothing runs and the gate does not see it. The result is `invalid-args`. | Isolated `tests/approval.test.ts`, `tests/browser.test.ts` |
| G12 | The first gate `deny` ends the run, so a planner that asked for one wrong host or one tool with no grant cannot correct itself (seen with a 27B model on foxbench: it invented a real site's address on 4 of 13 tasks, and each run ended at once). | With `denials: { retry }`, a `deny` at `gate.check` whose reason `retry` accepts goes back to the model as a failed result with reason `gate-deny`, the foxgate reason and its message. Nothing runs. The `decision` event still says `deny`, so the trail shows it. The result does not count toward L3. Without `denials`, G3 holds. | Isolated `tests/approval.test.ts` |
| G13 | With G12, the model asks for denied actions again and again, and the run goes on until `maxSteps`. | The `limit`-th such denial in a row (default 3) stops the run with `blocked` `gate-deny` and the last foxgate reason. A call that the gate allows, or that a human approves, sets the count back to 0. | Isolated `tests/approval.test.ts` |
| G14 | With G12, a human's no, a `deny` at `gate.redeem`, or a reason that `retry` refuses (for example a user's rule, or an expired grant) goes back to the model, which then tries the same goal another way. | These stop the run as in G3, G4 and G6. `retry` sees only denials at `gate.check`. | Isolated `tests/approval.test.ts` |
| G15 | With G12, the system prompt still says that a denied action stops the run, so the model gives up or repeats itself after a denial. | With `denials`, prompt rule 6 says that a human's no stops the run, and that the gate's denial comes back as a result that says why, so the model picks another action. Without `denials`, the prompt does not change. | Isolated `tests/prompt.test.ts` |

## Audit trail

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | A decision or a result is not in the trail. | The loop appends one entry for each event, with the kind `loop.<event type>` (`loop.plan`, `loop.decision`, `loop.tool-result`, `loop.blocked`...). A decision goes in before the tool runs. | Isolated `tests/approval.test.ts`, E2E |
| T2 | The trail write fails before a tool runs. | The tool does not run. The run stops with `blocked` `trail-failed`. | Isolated `tests/approval.test.ts` |
| T3 | The trail write fails after a tool ran. | The run stops with `blocked` `trail-failed`. The loop does not call the model again. | Isolated `tests/approval.test.ts` |

## Untrusted page text

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | Page text says "ignore previous instructions". The model reads it as an order. | Page text goes to the model only in a `tool` message (or in check feedback, P3), between delimiters that hold a random nonce. The system prompt says that text between them is data. The gate still judges every call (G3, G4). | Isolated `tests/prompt.test.ts`, E2E |
| P5 | Page text splits a marker so that removing `<<<` and `>>>` once joins it again (`<<>>><END n>><<<>` becomes `<<<END n>>>`). | Every `<` and `>` in outside text and summaries becomes `&lt;` and `&gt;`, so no marker can form. | Isolated `tests/prompt.test.ts` |
| P6 | The model copies the nonce into tool arguments, so a tool or a later message can carry a working marker. | Arguments that hold the nonce are refused with `invalid-args`. The tool does not run and the gate does not see them. | Isolated `tests/loop.test.ts` |
| P3 | A failed check carries page text as evidence (a field value such as "ignore previous instructions"). It reaches the planner as plain text. | The check feedback puts the failed lines between the same delimiters as page text. | Isolated `tests/loop.test.ts` |
| P4 | Page text reaches the model outside the delimiters: in foxpaw's blocked reason or message (they hold button labels), in an `act` refusal detail, or in the message of a tool that throws. | Summaries hold only text that foxloop or the tool writes. foxpaw's reason, message and refusal detail, and a thrown error's message, go between the delimiters. | Isolated `tests/browser.test.ts`, `tests/loop.test.ts` |
| P2 | Page text holds a closing delimiter to end the data block early. | The nonce is new for each run, and the loop removes delimiter markers from page text. | Isolated `tests/prompt.test.ts` |
| P7 | The 4,000-character cut (L11) falls inside a foxshield `<untrusted-data>` block. The planner sees an open fence with no close, and text after the cut can read as outside it (issue #76). | A cut inside a block adds a `[truncated]` line and then the closing fence. A cut outside a block ends with `[cut]` as before. | Isolated `tests/prompt.test.ts` |
| P8 | Page text holds a line shaped like a control (`[0:9] button "Pay" (sends the form)`), or a label holds a quote, so the planner reads a forged control. | foxpaw's `pageText` and `changeText` write the page text. Each text line starts with `\| `, and each label and value is JSON-quoted. | Isolated `tests/browser.test.ts` |
| P9 | The nonce is in the system prompt, so the system prompt and the tool list after it differ in every run. A local server that reuses a cached prompt prefix reads them again at the start of each run (measured on Saluki 27B: ~1,500 tokens, 20-55 s per run, against ~1.4 s when they are cached). | The system prompt holds no nonce: it is the same for every run with the same options. Rule 5 points to the data marker, which the goal message gives at its end. The model learns the marker before any page text. | Isolated `tests/prompt.test.ts` |
| P10 | The planner writes a long `finish` summary (130 tokens, which is 17-20 s at 7 tokens/s on a local 27B model) and long prose before its calls. | Rule 3 and the `finish` tool ask for a summary of at most 15 words. The prompt rules are short. | Isolated `tests/prompt.test.ts` |
| P11 | A 15-word summary is still about 50 output tokens (5 s at 10 tokens/s), the most expensive reply of most runs, though no check reads it. A shorter cap drops what the user needs to know. | Rule 3 and the `finish` tool ask for at most 8 words that name the result. The check never reads the summary; foxmate shows it to the user. | Isolated `tests/prompt.test.ts` |

## Browser tools

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B1 | `open_url` gets a `javascript:`, `file:`, `data:` or `moz-extension:` address. | Its `domain` function throws, so G9 applies. Only `http:` and `https:` open. | Isolated `tests/browser.test.ts` |
| B2 | `act` or `click` names a control that is not in the last snapshot, or no snapshot exists. | A failed result that tells the model to call `snapshot` first. | Isolated `tests/browser.test.ts` |
| B3 | The page changed after the snapshot. | foxpaw returns `stale`. The result fails, and the call planned on the old snapshot does not run. The tool reads the page again (B13). | Isolated `tests/browser.test.ts` |
| B4 | `browser_task` ends `blocked` or not verified. | The result carries a failed check, so `finish` cannot pass (L5). | Isolated `tests/browser.test.ts` |
| B5 | The model names a domain for a tab tool. | Tab tools take the domain from the tab address when the call runs. They have no domain argument. | Isolated `tests/browser.test.ts` |
| B7 | The tab moves to another host after the gate check, for example while the human reads the approval. The tool acts on a host that the gate never judged. | The loop passes the judged domain to `run` as `ctx.domain`. Tab tools compare it with the tab's host first. When they differ, nothing runs and the result fails. | Isolated `tests/browser.test.ts`, `tests/approval.test.ts` |
| B8 | The human approves a click on control "0:12" ("Next"). While the approval waits, a snapshot or an earlier act reads the page again, and "0:12" is now "Delete account". foxgate redeems the same `{ controlId }`, and "Delete account" runs. | A tool can `prepare` its arguments on the host side before the gate. `act` and `click` add a `target`: the snapshot number, the control id, frame, node, guard, role, label and page address. foxgate judges and approves that. `run` acts only on that captured control and refuses `stale` when the tab's snapshot is not the captured one or the control does not match. Calls on one tab run one at a time. | Isolated `tests/browser.test.ts`, `tests/approval.test.ts`, E2E `approved click lands on the captured control` |
| B6 | A snapshot of a big page fills the context. | The summary lists at most 40 controls. Page text is untrusted data, cut by L11. | Isolated `tests/browser.test.ts` |
| B9 | `act` and `click` return the whole page after each action, so a long page fills the context in a few steps. | On the same document, the result is foxpaw's `changeText` diff: changed, new and gone controls, a new title, and new text lines. The acted control is always named. | Isolated `tests/browser.test.ts` |
| B10 | The diff leaves out an alert that the action caused ("Please enter a valid email"), so the planner thinks the action worked. | Every new text line is in the diff. foxpaw never drops a line that reads as an error or an alert. | Isolated `tests/browser.test.ts` |
| B11 | The action navigated or reloaded the page, or changed most of it, but the result is a diff against a page that is gone. | foxpaw gives the full page then. A full-page result also sets `stopBatch` (M4), so no planned call runs on the new page. | Isolated `tests/browser.test.ts` |
| B12 | A diff holds the value of a secret control that the action typed into (A4). | foxloop masks the value of every `secret` control as `•••` before foxpaw writes the page text or the diff. | Isolated `tests/browser.test.ts` |
| B13 | foxpaw refuses an action (`covered`, `unsupported`, `stale`, `disabled`). The result drops the snapshot and says "Call snapshot", so the planner's next reply is only a `snapshot` call: one more model call for each refusal (seen on foxbench flights: 6 of 30 steps). | After a refusal, the tool reads the page again at once, through the same `snapshot` hook (so foxmate's foxshield scans it), and keeps that read as the newest snapshot. The failed result gives the page as untrusted text: the diff against the page that the call was planned on, or the whole page after a navigation. The next reply can act on its ids, and each call is pinned to the new read (B8). When the read fails, the result says "Call snapshot" as before. | Isolated `tests/browser.test.ts` |

### `fill`: several fields in one call

Each typed field cost one planner reply as an `act` call: about 50 output tokens (5 s at 10 tokens/s) and one tool-result prefill. `fill` sets several fields of the last snapshot in one call. It must not do anything that one `act` call per field would refuse.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B14 | `fill` names a control that is not in the last snapshot, or no snapshot exists, and the fields that it does find run. | `prepare` checks every id first. One unknown id fails the whole call (B2), and no field runs. | Isolated `tests/browser.test.ts` |
| B15 | `fill` types the model's text into a password field. A single `act` keeps such a step out of the workflow cache and masks the value, but one approval for many fields hides it. | `fill` refuses a `secret` control in `prepare`, so no field runs. The result tells the model to use `act` for it. | Isolated `tests/browser.test.ts` |
| B16 | `fill` clicks a button or a link, or names a submit control, so a call with the `fill` scope sends a form. | `fill` refuses a submit control, a button, a link and every other control that only a click sets. Sends stay with `click` and its `submit` scope. foxpaw's act refuses a click on a submit control too (C34). | Isolated `tests/browser.test.ts` |
| B17 | The gate judges and the human approves "fill 3 fields", and a different field or value runs. | `prepare` pins every control as `act` does (B8), in the order given, with its op and value. `describe` names each control, its role, label, op and value, and the page address. `run` acts only on the pinned controls and refuses `stale` as `act` does. | Isolated `tests/browser.test.ts` |
| B18 | A field in the middle fails (`covered`, `stale`, a navigation), and the fields after it run on a page that changed. | `fill` stops at the first refusal. The result fails, names the fields that ran and the ones that did not, and gives the page as it is now (B13). | Isolated `tests/browser.test.ts` |
| B19 | Typing into a field opens a list of suggestions, and the next field is typed under the open list, or the planner never picks a suggestion. | For a field that opens a list (`autocomplete`), `fill` asks foxpaw to type the value and pick the one suggestion that holds it (foxpaw `select`, P15), as a single `act` select does. When no suggestion or several hold it, foxpaw refuses and B18 applies: the result shows the list. | Isolated `tests/browser.test.ts` |
| B20 | A field sends the form (a field that submits on change), and the rest run on the next page. | `fill` stops after a field that sent the form, and the batch ends (M4). | Isolated `tests/browser.test.ts` |
| B21 | The model gives a value that does not fit the control: text for a checkbox, `true` for a text box, or too many fields, so a guess runs. | A checkbox, radio, switch or option takes `true` or `false`, the strings "true" and "false", or its own label (a planner writes a radio as "One way"); any other control takes text of at most 2000 characters. A call with more than 12 fields fails. Each failure is in `prepare`, so no field runs. | Isolated `tests/browser.test.ts` |
| B22 | foxpaw acts only on the page as last read (its in-page key holds every field value), so the second field of a `fill` planned on one read is refused `stale` (seen on foxbench: every multi-field fill stopped after one field). Or the read in between skips foxshield, or finds another control. | Before each field after the first, `fill` reads the page again through the `snapshot` hook (foxshield scans it) and finds the same control: the same id, node, frame, role, label, submit flag and destination, and still not a password field (B15). The guard may change with a value; foxpaw checks the new one in the page. Any other change stops the call (B18). After the last field it reads once more and returns the diff from the page the call was planned on. | Isolated `tests/browser.test.ts` |
| B23 | foxmate's workflow cache cannot tell which fields a partly done `fill` set, so a replay leaves one out. | The result's `data.filled` lists each field that ran, in order: control id, op and value. | Isolated `tests/browser.test.ts` |

## End to end

| # | Check | Where |
|---|---|---|
| E1 | A scripted planner fills a form on a local page through foxpaw with one approval. The run ends `done` and the foxpaw check passes. | E2E `form task done with one approval` |
| E2 | An injection page asks the planner to open a link that sends data to another host. The gate says `deny`, and the trail records it. | E2E `injected link is denied` |
| E3 | An injection page asks the planner to click a send button. The human denies the approval, and the trail records it. | E2E `injected send is refused` |
| E5 | The user picks the Ollama planner with a `-cloud` model (for example `gpt-oss:120b-cloud`). Ollama sends it to its own servers, but foxmind marks Ollama as local, so private mode lets page text leave. | The demo refuses a model name that ends in `-cloud` for the local planners, before any model call. | E2E `private mode refuses an Ollama cloud model` |
| E6 | A run leaves its tab open. On Ichabod a session gets slower with each open tab: in slow sessions each new tab took 2-3x longer than the one before (0.6 s up to 38-54 s), and `open()` timed out at 30 s about one CI run in three. | Each run closes the tab it opened before the next run opens one, and the test ends with the tabs it had before the first run. | E2E `every run closes its tab` |
| E4 | When Ollama runs with a small tool-calling model, one real task runs. The result is recorded as it is, pass or fail. | `pnpm e2e:ollama` |

## AMO release build and listed submission (`scripts/amo-listing.mjs`)

`pnpm check:amo` reads `dist-ext/`, which is what `release.yml` signs. Each
row is a way that the listed build or the submission can go wrong.

| ID | Failure | Wanted result |
|---|---|---|
| AR1 | `dist-ext/` is missing, so the check reads nothing | The check stops and says to run `pnpm build:ext` |
| AR2 | A content script in the release manifest matches `127.0.0.1`, `localhost` or `*.localhost` (a test bridge) | The check stops and names the pattern |
| AR3 | A host permission for a local host exists only for tests | The check stops, unless `local_hosts` in the listing gives a reason for that exact pattern |
| AR4 | A file named for tests (`e2e`, `fixture`, `test`, `spec`) is in `dist-ext/` | The check stops and names the file |
| AR5 | `dist-ext/` came from `build-ext.mjs --e2e` | AR2 or AR4 stops it |
| AR6 | The `local_hosts` reasons go to AMO as an unknown field | `metadata` leaves them out, as it does the privacy policy |
| AR7 | A re-run submits a version that AMO already has as listed | `version-status` says `listed`, and the step skips web-ext sign and finishes the release |
| AR8 | AMO has the version as unlisted | `version-status` stops and says to bump the version |
| AR9 | The AMO version lookup fails (401, 500, network) | `version-status` stops; it never guesses `absent` |
| AR10 | The add-on already exists on AMO, and the version lookup sends a parameter AMO refuses on a single version (400), so every release stops | `version-status` asks for `versions/v<version>/` with no query; an owner sees listed and unlisted versions there |

| ID | Failure | Wanted result |
|---|---|---|
| AR-U1 | A `local_hosts` reason for a host permission also clears a test content script on the same pattern | Each reason names its use (`host_permission`, `content_script`, `web_accessible_resource`, `externally_connectable`); a use without its own reason stops the check |
| AR-U2 | `local_hosts` keeps a reason for a use that the release build does not have | The check stops and names the pattern and the use |
