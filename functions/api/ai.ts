import { API_CACHE_HEADERS, getAiSnapshot, readRecentSnapshot, requestForcesRefresh, retainLastLiveSnapshot } from "./data";

export const onRequestGet = async ({ request }: { request: Request }) => {
  const force = requestForcesRefresh(request);
  const cached = force ? null : await readRecentSnapshot(request);
  const snapshot = cached ?? await retainLastLiveSnapshot(request, await getAiSnapshot(force));
  return Response.json(snapshot, { headers: API_CACHE_HEADERS });
};
