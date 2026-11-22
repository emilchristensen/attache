import type { BriefingsResponse } from "@attache/contracts";
import { useResource, type Resource } from "../live.ts";

/**
 * The latest Daily Briefing and the latest away summary or briefing asked for (`GET /briefings`), asked again when a
 * briefing is written. The Daily Briefing area, For you now, meeting prep and the briefing page all read it.
 */
export function useBriefings(enabled = true): Resource<BriefingsResponse> {
  return useResource<BriefingsResponse>(enabled ? "/briefings" : null, ["briefing.created"]);
}
