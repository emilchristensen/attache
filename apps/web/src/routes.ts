import type { IconName } from "./components/icons.tsx";

/** The Dashboard's screens behind the shell (Setup and pairing have no shell). */
export type ScreenId = "home" | "briefing" | "approvals" | "brain" | "connections" | "jobs" | "settings";

export interface Screen {
  id: ScreenId;
  /** Its address; sub-states live under it (`/brain?path=`, a Draft at `/approvals/<id>`, `/settings/<section>`). */
  to: string;
  label: string;
  /** The letter after `g` that jumps here. */
  key: string;
  icon: IconName;
}

/** Every screen, in the masthead's order. The old `/memory` and `/drafts` routes are gone on purpose, with no redirects. */
export const SCREENS: readonly Screen[] = [
  { id: "home", to: "/", label: "Home", key: "h", icon: "home" },
  { id: "approvals", to: "/approvals", label: "Approvals", key: "a", icon: "approvals" },
  { id: "brain", to: "/brain", label: "Brain", key: "b", icon: "brain" },
  { id: "connections", to: "/connections", label: "Connections", key: "c", icon: "connections" },
  { id: "jobs", to: "/jobs", label: "Jobs", key: "j", icon: "jobs" },
  { id: "settings", to: "/settings", label: "Settings", key: "s", icon: "settings" },
];

export function screen(id: ScreenId): Screen {
  return id === "briefing" ? SCREENS[0]! : SCREENS.find((s) => s.id === id)!;
}

/** The screen at `path`: Home at `/` only, every other screen at its address or below it; null for anything else. */
export function screenAt(path: string): ScreenId | null {
  if (path === "/") return "home";
  if (/^\/briefing\/[^/]+$/.test(path)) return "briefing";
  return SCREENS.find((s) => s.to !== "/" && (path === s.to || path.startsWith(`${s.to}/`)))?.id ?? null;
}

/** The narrow bottom bar's tabs; the rest of the screens are under More. */
export const BOTTOM_BAR_SCREENS: readonly ScreenId[] = ["home", "approvals", "brain"];
export const MORE_SCREENS: readonly ScreenId[] = ["jobs", "connections", "settings"];

/** The Settings section groups, in the section list's order. */
export type SettingsGroup = "Attache" | "Brain" | "Machines" | "Service";

export interface SettingsSection {
  id: string;
  label: string;
  group: SettingsGroup;
}

/**
 * Every Settings section, each at `/settings/<id>`, in the section list's order. Settings shows one at a time; the
 * search palette's Go to group and the Machine panel reach them by these addresses.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "features", label: "Features", group: "Attache" },
  { id: "schedules", label: "Schedules and notifications", group: "Attache" },
  { id: "identity", label: "Identity", group: "Attache" },
  { id: "saving", label: "Saving and review", group: "Brain" },
  { id: "meaning-search", label: "Meaning-based search", group: "Brain" },
  { id: "backup", label: "Backup and export", group: "Brain" },
  { id: "machines", label: "Machines and Replication", group: "Machines" },
  { id: "clients", label: "Paired clients", group: "Machines" },
  { id: "service", label: "Service health", group: "Service" },
];

export function settingsHref(id: string): string {
  return `/settings/${id}`;
}

/** The section list: each group once, with its sections, in order. */
export function settingsGroups(): Array<{ group: SettingsGroup; sections: SettingsSection[] }> {
  return SETTINGS_SECTIONS.reduce<Array<{ group: SettingsGroup; sections: SettingsSection[] }>>((groups, s) => {
    const last = groups[groups.length - 1];
    return last?.group === s.group ? [...groups.slice(0, -1), { ...last, sections: [...last.sections, s] }] : [...groups, { group: s.group, sections: [s] }];
  }, []);
}

/** The Settings section `path` names, or null for Settings itself, another screen or an unknown section. */
export function settingsSectionAt(path: string): string | null {
  const id = path.startsWith("/settings/") ? path.slice("/settings/".length) : null;
  return SETTINGS_SECTIONS.some((s) => s.id === id) ? id : null;
}

/** The section Settings shows at `path`: the first one at `/settings` itself, else the one named; null for an unknown one. */
export function settingsSectionShown(path: string): string | null {
  return path === "/settings" ? SETTINGS_SECTIONS[0]!.id : settingsSectionAt(path);
}

/** Approvals' tabs: Waiting at `/approvals`, Finished at `/approvals?tab=finished`. */
export type ApprovalsTab = "waiting" | "finished";
export const approvalsHref = (tab: ApprovalsTab = "waiting") => (tab === "finished" ? "/approvals?tab=finished" : "/approvals");

/** A waiting Proposal on Approvals' Waiting tab, opened in place with the keyboard on it: `/approvals?proposal=<id>`. */
export const proposalHref = (id: string) => `/approvals?proposal=${encodeURIComponent(id)}`;

/** A Draft's own page, under Approvals (Approvals stays selected in the navigation). */
export const draftHref = (id: string) => `/approvals/${encodeURIComponent(id)}`;

/** The Draft whose own page `path` is, or null: `/approvals/<id>`. */
export function draftAt(path: string): string | null {
  const m = /^\/approvals\/([^/]+)$/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}
