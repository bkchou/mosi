import assert from "node:assert/strict";
import test from "node:test";
import { fetchKalshiJson } from "../functions/lib/kalshi.ts";

const endpoint = "https://external-api.kalshi.com/trade-api/v2/markets?series_ticker=KXGPT";

function response(status, payload = {}, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers });
}

async function signingMaterial() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const binary = String.fromCharCode(...new Uint8Array(privateKey));
  const encoded = btoa(binary).replace(/(.{64})/g, "$1\n");
  return {
    publicKey: keyPair.publicKey,
    env: {
      KALSHI_API_KEY_ID: "test-key-id",
      KALSHI_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
    },
  };
}

test("signs the timestamp, GET, and pathname while excluding the query", async () => {
  const { publicKey, env } = await signingMaterial();
  let init;
  await fetchKalshiJson(endpoint, env, async (_url, request) => {
    init = request;
    return response(200, { markets: [] });
  });

  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal(init.headers.get("KALSHI-ACCESS-KEY"), "test-key-id");
  const timestamp = init.headers.get("KALSHI-ACCESS-TIMESTAMP");
  const signature = Uint8Array.from(atob(init.headers.get("KALSHI-ACCESS-SIGNATURE")), (character) => character.charCodeAt(0));
  const canonical = new TextEncoder().encode(`${timestamp}GET/trade-api/v2/markets`);
  assert.equal(await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, publicKey, signature, canonical), true);
  const withQuery = new TextEncoder().encode(`${timestamp}GET/trade-api/v2/markets?series_ticker=KXGPT`);
  assert.equal(await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, publicKey, signature, withQuery), false);
});

test("uses an unsigned public request when Kalshi credentials are absent", async () => {
  let headers;
  await fetchKalshiJson(endpoint, {}, async (_url, init) => {
    headers = init.headers;
    return response(200, { markets: [] });
  });
  assert.equal(headers.has("KALSHI-ACCESS-SIGNATURE"), false);
});

test("rejects incomplete credentials and destinations before making a request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(200); };
  await assert.rejects(() => fetchKalshiJson(endpoint, { KALSHI_API_KEY_ID: "only-id" }, fetchImpl), /credentials are incomplete/);
  await assert.rejects(() => fetchKalshiJson("https://example.com/trade-api/v2/markets", {}, fetchImpl), /Invalid Kalshi request URL/);
  await assert.rejects(() => fetchKalshiJson("https://external-api.kalshi.com/trade-api/v2/markets/anything", {}, fetchImpl), /Invalid Kalshi request URL/);
  await assert.rejects(() => fetchKalshiJson("https://user:password@external-api.kalshi.com/trade-api/v2/markets", {}, fetchImpl), /Invalid Kalshi request URL/);
  assert.equal(calls, 0);
});

test("does not retry authorization failures", async () => {
  let calls = 0;
  await assert.rejects(() => fetchKalshiJson(endpoint, {}, async () => {
    calls += 1;
    return response(401);
  }), /Kalshi request failed: 401/);
  assert.equal(calls, 1);
});

test("does not follow redirects", async () => {
  let calls = 0;
  await assert.rejects(() => fetchKalshiJson(endpoint, {}, async () => {
    calls += 1;
    return new Response("", { status: 302, headers: { location: "https://example.com/" } });
  }), /Kalshi request failed: 302/);
  assert.equal(calls, 1);
});

test("regenerates signed headers and cancels a transient response before retrying", async () => {
  const { env } = await signingMaterial();
  const originalSetTimeout = globalThis.setTimeout;
  const originalDateNow = Date.now;
  const timestamps = [];
  let calls = 0;
  let cancellations = 0;
  globalThis.setTimeout = (callback, _milliseconds, ...args) => originalSetTimeout(callback, 0, ...args);
  Date.now = () => 1_000 + calls;
  try {
    await fetchKalshiJson(endpoint, env, async (_url, init) => {
      calls += 1;
      timestamps.push(init.headers.get("KALSHI-ACCESS-TIMESTAMP"));
      if (calls === 1) return {
        ok: false,
        status: 503,
        headers: new Headers(),
        body: { cancel: async () => { cancellations += 1; } },
      };
      return response(200, { markets: [] });
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.deepEqual(timestamps, ["1000", "1001"]);
  assert.equal(cancellations, 1);
});

test("retries transient responses no more than three times and bounds retry-after", async () => {
  let calls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, _milliseconds, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    await assert.rejects(() => fetchKalshiJson(endpoint, {}, async () => {
      calls += 1;
      return response(503, {}, { "retry-after": "99999" });
    }), /Kalshi request failed: 503/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(calls, 3);
});
