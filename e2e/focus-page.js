// The page that the focus E2E opens in the extension: it reads a tab through browserTools and returns the text.
import * as foxpaw from "foxpaw";
import { browserTools } from "../src/index.ts";

const ctx = { signal: new AbortController().signal, step: 1, goal: "" };

window.readPage = async (url, focus) => {
  const tab = (await browser.tabs.query({})).find((t) => t.url === url);
  const tools = browserTools({ tabId: () => tab.id, ...(focus === undefined ? {} : { focus: () => focus }) });
  const out = await tools.find((t) => t.name === "snapshot").run({}, ctx);
  return { text: out.untrusted, plain: foxpaw.pageText(await foxpaw.snapshot(tab.id)) };
};
