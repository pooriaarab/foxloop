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
| L7 | The run uses more tokens, tool calls or time than the budget. | Before each model call and each tool call, the loop compares the totals with `budget`. Over the budget, it stops with `blocked` `budget`. | Isolated `tests/loop.test.ts` |
| L8 | The user aborts during a model call. | The signal goes to `mind.chat`. The run stops with `aborted`. No tool runs. | Isolated `tests/loop.test.ts` |
| L9 | The user aborts during a tool call, and the tool ignores the signal. | The run stops with `aborted` at once. The late result does not go to the model. | Isolated `tests/loop.test.ts` |
| L10 | The model call fails (server down, bad reply). | The run stops with `blocked` `model-error`. The loop does not retry. | Isolated `tests/loop.test.ts` |
| L11 | A tool returns a very long result. The model context fills up. | The summary is cut to 2,000 characters and page text to 4,000. Old page text is removed from the history when the history is over 24,000 characters. | Isolated `tests/prompt.test.ts` |
| L12 | The caller stops reading events (`break`). The loop keeps acting in the background. | The loop stops at the next step. No more tools run. | Isolated `tests/loop.test.ts` |
| L13 | The caller starts a second run on the same loop while one runs. Two runs share the history. | The second `run` throws `busy`. | Isolated `tests/loop.test.ts` |

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
| G9 | The tool's `domain` function throws (for example `open_url` gets `javascript:`). | Nothing runs and the gate does not see it. The result is `invalid-args`. | Isolated `tests/approval.test.ts`, `tests/browser.test.ts` |

## Audit trail

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | A decision or a result is not in the trail. | The loop appends one entry for each event, with the kind `loop.<event type>` (`loop.plan`, `loop.decision`, `loop.tool-result`, `loop.blocked`...). A decision goes in before the tool runs. | Isolated `tests/approval.test.ts`, E2E |
| T2 | The trail write fails before a tool runs. | The tool does not run. The run stops with `blocked` `trail-failed`. | Isolated `tests/approval.test.ts` |
| T3 | The trail write fails after a tool ran. | The run stops with `blocked` `trail-failed`. The loop does not call the model again. | Isolated `tests/approval.test.ts` |

## Untrusted page text

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | Page text says "ignore previous instructions". The model reads it as an order. | Page text goes to the model only in a `tool` message, between delimiters that hold a random nonce. The system prompt says that text between them is data. The gate still judges every call (G3, G4). | Isolated `tests/prompt.test.ts`, E2E |
| P2 | Page text holds a closing delimiter to end the data block early. | The nonce is new for each run, and the loop removes delimiter markers from page text. | Isolated `tests/prompt.test.ts` |

## Browser tools

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B1 | `open_url` gets a `javascript:`, `file:`, `data:` or `moz-extension:` address. | Its `domain` function throws, so G9 applies. Only `http:` and `https:` open. | Isolated `tests/browser.test.ts` |
| B2 | `act` or `click` names a control that is not in the last snapshot, or no snapshot exists. | A failed result that tells the model to call `snapshot` first. | Isolated `tests/browser.test.ts` |
| B3 | The page changed after the snapshot. | foxpaw returns `stale`. The result fails, and the snapshot is dropped. | Isolated `tests/browser.test.ts` |
| B4 | `browser_task` ends `blocked` or not verified. | The result carries a failed check, so `finish` cannot pass (L5). | Isolated `tests/browser.test.ts` |
| B5 | The model names a domain for a tab tool. | Tab tools take the domain from the tab address when the call runs. They have no domain argument. | Isolated `tests/browser.test.ts` |
| B6 | A snapshot of a big page fills the context. | The summary lists at most 40 controls. Page text is untrusted data, cut by L11. | Isolated `tests/browser.test.ts` |

## End to end

| # | Check | Where |
|---|---|---|
| E1 | A scripted planner fills a form on a local page through foxpaw with one approval. The run ends `done` and the foxpaw check passes. | E2E `form task done with one approval` |
| E2 | An injection page asks the planner to open a link that sends data to another host. The gate says `deny`, and the trail records it. | E2E `injected link is denied` |
| E3 | An injection page asks the planner to click a send button. The human denies the approval, and the trail records it. | E2E `injected send is refused` |
| E4 | When Ollama runs with a small tool-calling model, one real task runs. The result is recorded as it is, pass or fail. | `pnpm e2e:ollama` |
