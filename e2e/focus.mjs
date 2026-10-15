// The focus E2E: browserTools reads a page of 120 controls in a real Firefox. The control that the goal
// names sits at slot 95, so the default read of 40 controls does not show it. With `focus` it must.
// Usage: pnpm e2e:focus. Env: FIREFOX (the Firefox binary).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { launch, serve } from "create-foxkit/e2e";

const dir = "dist-ext-focus";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
await build({ entryPoints: ["e2e/focus-page.js"], outfile: `${dir}/focus-page.js`, bundle: true, format: "esm", target: "firefox153", logLevel: "warning" });
writeFileSync(`${dir}/focus.html`, '<!doctype html><meta charset="utf-8"><script type="module" src="focus-page.js"></script>');
writeFileSync(`${dir}/manifest.json`, JSON.stringify({
  manifest_version: 3, name: "foxloop focus E2E", version: "0.0.1",
  browser_specific_settings: { gecko: { id: "foxloop-focus@pooriaarab", data_collection_permissions: { required: ["none"] } } },
  permissions: ["scripting", "tabs"], host_permissions: ["<all_urls>"],
}));

/** The control line of the target, with its id. */
const control = /^\[(\d+:\d+)\] button "Mystery books"/m;
const site = await serve("e2e/site");
let fox;
let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok " : "BAD"} ${name}: ${detail}`);
  failed ||= !ok;
};
try {
  fox = await launch({ extension: dir, headless: true });
  const url = `${site.url}/focus.html`;
  const tab = await fox.open(url);
  const ext = await fox.openExtensionPage("focus.html");
  const focused = await ext.evaluate((u) => window.readPage(u, "mystery books"), url);
  const plain = await ext.evaluate((u) => window.readPage(u), url);
  await tab.close();
  const target = control.exec(focused.text);
  check("read without focus misses the control past slot 40", !control.test(plain.text), `${plain.text.length} chars`);
  check("read without focus equals the foxpaw default byte for byte", plain.text === plain.plain, `${plain.text.length} chars`);
  check("read with focus shows the control", Boolean(target), `id ${target?.[1]}`);
  check("read with focus is under 1500 chars", focused.text.length < 1500, `${focused.text.length} chars`);
} catch (error) {
  check("run", false, error instanceof Error ? error.message : String(error));
} finally {
  await fox?.close();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "FAIL" : "PASS");
process.exitCode = failed ? 1 : 0;
