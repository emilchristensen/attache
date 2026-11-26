/**
 * The exit code of a service that refused to start and must not be started
 * again until something changes, such as a database a newer Attache wrote
 * (`core/schema-guard.ts`). 78 is EX_CONFIG from sysexits.h. systemd and the
 * Windows supervisor read this code; launchd cannot tell exit codes apart, so
 * the service also leaves `REFUSED_TO_START_FILE` in its state folder, and
 * removes it once it starts.
 */
export const REFUSED_EXIT_CODE = 78;
export const REFUSED_TO_START_FILE = "refused-to-start";

/** What the background service runs: the installed release, on a port, against a state folder. */
export interface ServiceSpec {
  /** Install location holding the `current` link to the running release. */
  installPrefix: string;
  stateDir: string;
  port: number;
  /** Install name, passed on to the service as `ATTACHE_INSTANCE`. */
  instance: string;
  /**
   * Where the service lists releases, passed on as `ATTACHE_RELEASE_FEED_URL` when the installer was given one: the
   * install test points it at a local server. A release still needs the signature of a key the Machine trusts.
   */
  releaseFeedUrl?: string;
}

/**
 * Runs Attache as a per-user background service that starts at login and is
 * restarted if it stops: a launchd agent on macOS, a systemd user service on
 * Linux, a logon task on Windows.
 */
export interface ServiceManager {
  /** The name the operating system knows the service by. */
  readonly name: string;
  /** Where its definition lives, for messages; null where it is not a file. */
  readonly definition: string | null;
  /** Write or replace the service definition. Does not start the service. */
  install(spec: ServiceSpec): Promise<void>;
  /** Start the installed service; restarts it when it is already running. */
  start(): Promise<void>;
  /** Stop the service and wait until it has stopped. Stopping a service that is not running succeeds. */
  stop(): Promise<void>;
  /** Stop the service and remove its definition. */
  uninstall(): Promise<void>;
  /** Whether the service is loaded under the owner's session. */
  loaded(): Promise<boolean>;
}
