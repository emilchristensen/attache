import { serviceName, type PlatformLocations } from "../locations.ts";
import { LaunchdServiceManager } from "./launchd.ts";
import { SystemdServiceManager } from "./systemd.ts";
import { TaskSchedulerServiceManager } from "./task-scheduler.ts";
import type { ServiceManager } from "./types.ts";

export type { ServiceManager, ServiceSpec } from "./types.ts";

/**
 * The service manager for this install: launchd on macOS, a systemd user
 * service on Linux, a logon task in Task Scheduler on Windows.
 */
export function serviceManagerFor(loc: PlatformLocations, instance: string): ServiceManager {
  switch (loc.os) {
    case "macos":
      return new LaunchdServiceManager(loc, serviceName(loc.os, instance));
    case "linux":
      return new SystemdServiceManager(loc, serviceName(loc.os, instance));
    case "windows":
      return new TaskSchedulerServiceManager(loc, instance);
  }
}
