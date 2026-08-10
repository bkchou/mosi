import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Fed dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Where rates go next\./);
  assert.match(html, /Monitoring/);
  assert.match(html, /-the-/);
  assert.match(html, /Situation/);
  assert.match(html, /Consensus probability graph/);
  assert.match(html, /Venue midpoints normalized to 100%/);
  assert.match(html, /Inflation history \+ gauges/);
  assert.match(html, /SOFR path \+ Treasury curve/);
  assert.match(html, /Official published market data/);
  assert.doesNotMatch(html, /61%|58%|3 of 4 venues|−51 bp/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});

test("server-renders the AI Models screen and production metadata", async () => {
  const response = await render("/ai-models");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /When the next models land\./);
  assert.match(html, /Market-implied model releases/);
  assert.match(html, /exact dates interpolate between quoted contracts/);
  assert.doesNotMatch(html, /What the markets are actually trading/);
  assert.doesNotMatch(html, /Q1 2027|Reference windows|false precision/);
  assert.match(html, /MOSI/);
  assert.match(html, /og\.png/);
});

test("removes disposable starter assets", async () => {
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
  const packageJson = await readFile(new URL("package.json", root), "utf8");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
