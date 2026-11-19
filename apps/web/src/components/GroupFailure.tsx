import type { ApiError } from "../api.ts";
import { clockTime } from "../zoned-time.ts";
import { Icon } from "./icons.tsx";

/**
 * A list's own request failure (an Approvals group, Home's Inbox), on first load or after a good load: what failed, the rows still shown and how old
 * they are, and Retry. Never an empty list. `counted`: the count leaves the group's rows out
 * (it is counting from the lists, and this one failed).
 */
export function GroupFailure({ what, error, answeredAt, retry, retained, counted = false }: { what: string; error: ApiError; answeredAt: number | null; retry: () => void; retained: boolean; counted?: boolean }) {
  const at = answeredAt === null ? null : clockTime(answeredAt, Intl.DateTimeFormat().resolvedOptions().timeZone);
  return (
    <div className="group-failure" role="alert" data-group-failure>
      <Icon name="warning" size={18} />
      <p>
        {retained && at ? (
          <>
            <strong>{what} could not be refreshed.</strong> These are the rows from {at}. They may have changed{counted ? ", and the count leaves them out" : ""}.
          </>
        ) : (
          <>
            <strong>{what} could not be loaded.</strong> This is not an empty list: Attache does not know what is here.
          </>
        )}{" "}
        <span className="group-failure-reason">{error.message}</span>
      </p>
      <button className="small" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
