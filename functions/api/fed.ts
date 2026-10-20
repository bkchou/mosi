import type { KalshiEnv } from "../lib/kalshi";
import { API_CACHE_HEADERS, getFedSnapshot, readRecentSnapshot, requestForcesRefresh, retainLastLiveSnapshot } from "./data";

export const onRequestGet = async ({ request, env }: { request: Request; env?: KalshiEnv }) => {
  const force = requestForcesRefresh(request);
  const cached = force ? null : await readRecentSnapshot(request);
  const snapshot = cached ?? await retainLastLiveSnapshot(request, await getFedSnapshot(force, env));
  return Response.json(snapshot, { headers: API_CACHE_HEADERS });
};
