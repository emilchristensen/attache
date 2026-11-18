import type { IconName } from "./components/icons.tsx";

/** The Dashboard's screens behind the shell (Setup and pairing have no shell). */
export type ScreenId = "home" | "approvals" | "brain" | "connections" | "jobs" | "settings";

export interface Screen {
  id: ScreenId;
  /** Its address; sub-states live under it (`/brain?path=`, later `/approvals/<id>`, `/settings/<section>`). */
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
  return SCREENS.find((s) => s.id === id)!;
}

/** The screen at `path`: Home at `/` only, every other screen at its address or below it; null for anything else. */
export function screenAt(path: string): ScreenId | null {
  if (path === "/") return "home";
  return SCREENS.find((s) => s.to !== "/" && (path === s.to || path.startsWith(`${s.to}/`)))?.id ?? null;
}

/** The narrow bottom bar's tabs; the rest of the screens are under More. */
export const BOTTOM_BAR_SCREENS: readonly ScreenId[] = ["home", "approvals", "brain"];
export const MORE_SCREENS: readonly ScreenId[] = ["jobs", "connections", "settings"];
