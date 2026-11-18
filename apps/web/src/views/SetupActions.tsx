import type { ReactNode } from "react";

/** A Setup step's Back and Continue: Continue is the solid button, kept in view at the bottom of the window on a long step. */
export function SetupActions({ children }: { children: ReactNode }) {
  return <div className="setup-actions">{children}</div>;
}
