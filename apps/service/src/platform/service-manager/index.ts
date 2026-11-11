import { NotYetOnPlatformError } from "../os.ts";
import { serviceName, type PlatformLocations } from "../locations.ts";
import { LaunchdServiceManager } from "./launchd.ts";
import { SystemdServiceManager } from "./systemd.ts";
import type { ServiceManager } from "./types.ts";

export type { ServiceManager, ServiceSpec } from "./types.ts";

/**
 * The service manager for this install: launchd on macOS, a systemd user
 * service on Linux. The logon task (Windows) arrives with that release.
 */
export function serviceManagerFor(loc: PlatformLocations, instance: string): ServiceManager {
  switch (loc.os) {
    case "macos":
      return new LaunchdServiceManager(loc, serviceName(loc.os, instance));
    case "linux":
      return new SystemdServiceManager(loc, serviceName(loc.os, instance));
    case "windows":
      throw new NotYetOnPlatformError("Running Jarvis as a background service", loc.os, "Run `jarvis serve` to start it in this terminal instead.");
  }
}
