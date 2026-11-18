import type { ApiError } from "../api.ts";
import { CompactScreen } from "../components/CompactScreen.tsx";

/**
 * The Dashboard could not reach the service on this computer: what to run to check it, and Retry.
 * A plain network failure says nothing the title does not; any other answer is shown as the service gave it.
 */
export function ServiceUnreachable({ error, retry }: { error: ApiError | null; retry: () => void }) {
  return (
    <CompactScreen>
      <h1>Attache service is not reachable</h1>
      <p className="compact-lead">The service normally starts when you log in. Nothing is lost while it is down: your Brain is the folder on this computer.</p>
      <ol className="compact-steps">
        <li>
          Run <code>attache status</code> in a terminal to see whether it is running.
        </li>
        <li>
          Run <code>attache start</code> to start it. Running the installer again repairs it without touching your data.
        </li>
      </ol>
      {error && error.code !== "offline" && (
        <p className="compact-note" role="status">
          The last try said: {error.message}
        </p>
      )}
      <button type="button" className="primary wide" onClick={retry}>
        Retry
      </button>
    </CompactScreen>
  );
}
