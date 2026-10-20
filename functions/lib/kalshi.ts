export type KalshiEnv = {
  KALSHI_API_KEY_ID?: string;
  KALSHI_PRIVATE_KEY?: string;
};

const KALSHI_ORIGIN = "https://external-api.kalshi.com";
const KALSHI_MARKETS_PATH = "/trade-api/v2/markets";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 5_000;

let cachedPrivateKeyPem: string | undefined;
let cachedPrivateKey: CryptoKey | undefined;

function allowedKalshiUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Kalshi request URL");
  }

  if (url.origin !== KALSHI_ORIGIN || url.pathname !== KALSHI_MARKETS_PATH || url.username || url.password) {
    throw new Error("Invalid Kalshi request URL");
  }
  return url;
}

function pemBytes(pem: string): Uint8Array {
  if (!/-----BEGIN PRIVATE KEY-----/.test(pem) || !/-----END PRIVATE KEY-----/.test(pem)) {
    throw new Error("Kalshi private key is invalid");
  }

  try {
    const encoded = pem
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Kalshi private key is invalid");
  }
}

async function privateKeyFor(pem: string): Promise<CryptoKey> {
  if (cachedPrivateKeyPem === pem && cachedPrivateKey) return cachedPrivateKey;

  try {
    const bytes = pemBytes(pem);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { name: "RSA-PSS", hash: "SHA-256" },
      false,
      ["sign"],
    );
    cachedPrivateKeyPem = pem;
    cachedPrivateKey = key;
    return key;
  } catch {
    throw new Error("Kalshi private key is invalid");
  }
}

function base64(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < values.length; index += 0x8000) {
    binary += String.fromCharCode(...values.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function signedHeaders(url: URL, env: Required<KalshiEnv>): Promise<Headers> {
  const timestamp = String(Date.now());
  const payload = new TextEncoder().encode(`${timestamp}GET${url.pathname}`);
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    await privateKeyFor(env.KALSHI_PRIVATE_KEY),
    payload,
  );
  return new Headers({
    accept: "application/json",
    "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": base64(signature),
  });
}

function retryAfterMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(parsed)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, parsed));
  }
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed cleanup must not hide the Kalshi response status.
  }
}

function hasCredentials(env: KalshiEnv): env is Required<KalshiEnv> {
  const hasKeyId = Boolean(env.KALSHI_API_KEY_ID);
  const hasPrivateKey = Boolean(env.KALSHI_PRIVATE_KEY);
  if (hasKeyId !== hasPrivateKey) throw new Error("Kalshi credentials are incomplete");
  return hasKeyId;
}

/** Fetches a Kalshi markets response, signing only when both server-side credentials exist. */
export async function fetchKalshiJson(
  value: string,
  env: KalshiEnv = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = allowedKalshiUrl(value);
  const credentials = hasCredentials(env) ? env : undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const headers = credentials ? await signedHeaders(url, credentials) : new Headers({ accept: "application/json" });
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers,
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt + 1 === MAX_ATTEMPTS) {
        const name = error && typeof error === "object" && "name" in error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") throw new Error("Kalshi request timeout");
        throw new Error("Kalshi request failed");
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new Error("Kalshi response was invalid");
      }
    }
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < MAX_ATTEMPTS) {
      await discardResponse(response);
      await sleep(retryAfterMs(response, attempt));
      continue;
    }
    throw new Error(`Kalshi request failed: ${response.status}`);
  }

  throw new Error("Kalshi request failed");
}
