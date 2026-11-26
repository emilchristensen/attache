import type { ReplicationView } from "@attache/contracts";
import { useResource, type Resource } from "./live.ts";

/**
 * This Machine's Replication as the service reports it (`GET /replication`), read again on every `replication.changed`
 * (a pause begins or ends, a check finds a new cause) and on `config.changed`. Settings' Machines and Replication
 * section and the line under the masthead (#143, "Update this Machine to keep replicating") both read it here.
 */
export function useReplication(): Resource<ReplicationView> {
  return useResource<ReplicationView>("/replication", ["replication.changed", "config.changed"]);
}
