import { UPDATES_EVENT, type UpdatesView } from "@attache/contracts";
import { useResource, type Resource } from "./live.ts";

/**
 * Updates on this Machine as the service reports them (`GET /updates`), read again on every `updates.changed` and
 * whenever live updates reconnect, as they do after the service restarts on a new version. Settings' Updates section
 * and the line under the masthead (#141) both read it here.
 */
export function useUpdates(): Resource<UpdatesView> {
  return useResource<UpdatesView>("/updates", [UPDATES_EVENT, "config.changed"]);
}
