import type { ReactNode } from "react";
import { SETTINGS_SECTIONS } from "../routes.ts";
import { settingsSectionDomId } from "./settings-section.ts";

/**
 * One Settings section, the only one on screen: its name at the section-heading scale, a sentence on what it is for,
 * then its parts. A named group, not a landmark, so "Replication" region locators stay unique. It takes focus when the
 * owner arrives at it from elsewhere (the palette, the Machine panel, a narrow window's list).
 */
export function SettingsSection({ id, lede, children }: { id: string; lede: ReactNode; children: ReactNode }) {
  const label = SETTINGS_SECTIONS.find((s) => s.id === id)!.label;
  const dom = settingsSectionDomId(id);
  return (
    <div id={dom} className="settings-section" role="group" aria-labelledby={`${dom}-title`} data-settings-section={id} tabIndex={-1}>
      <div className="settings-section-head">
        <h2 id={`${dom}-title`}>{label}</h2>
        <p className="settings-lede">{lede}</p>
      </div>
      {children}
    </div>
  );
}
