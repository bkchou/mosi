import { API_CACHE_HEADERS, getAiSnapshot, kalshiAiTickersFromRequest, readRecentSnapshot, requestForcesRefresh, retainLastLiveSnapshot } from "./data";

export const onRequestGet = async ({ request }: { request: Request }) => {
  const force = requestForcesRefresh(request);
  const knownTickers = kalshiAiTickersFromRequest(request);
  const cached = force ? null : await readRecentSnapshot(request);
  const fresh = cached ?? await getAiSnapshot(force, knownTickers);
  const snapshot = cached || knownTickers.length ? fresh : await retainLastLiveSnapshot(request, fresh);
  return Response.json(snapshot, { headers: API_CACHE_HEADERS });
};
