import type { KalshiEnv } from "../lib/kalshi";
import { getRecessionSnapshot } from "../lib/macro";
import { API_CACHE_HEADERS, readRecentSnapshot, requestForcesRefresh, retainLastLiveSnapshot } from "./data";

export const onRequestGet = async ({ request, env }: { request: Request; env?: KalshiEnv }) => {
  const force = requestForcesRefresh(request);
  const cached = force ? null : await readRecentSnapshot(request);
  const fresh = cached ?? await getRecessionSnapshot(force, env);
  const snapshot = cached ? fresh : await retainLastLiveSnapshot(request, fresh);
  return Response.json(snapshot, { headers: API_CACHE_HEADERS });
};
