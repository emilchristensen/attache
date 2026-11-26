import { useEffect, useRef, type ComponentType, type RefObject } from "react";
import { settingsHref, settingsSectionShown } from "../routes.ts";
import { Link, useLocation } from "../components/ui.tsx";
import { revealSettingsSection, shownOnScreen } from "./settings-section.ts";
import { FeaturesSection, IdentitySection, SchedulesSection } from "./SettingsAttache.tsx";
import { BackupSection, MeaningSearchSection, SavingSection } from "./SettingsBrain.tsx";
import { ClientsSection, MachinesSection } from "./SettingsMachines.tsx";
import { SettingsNav } from "./SettingsNav.tsx";
import { ServiceSection } from "./SettingsService.tsx";
import { UpdatesSection } from "./SettingsUpdates.tsx";

/** Each section's view, by its id in `SETTINGS_SECTIONS`. */
const SECTION_VIEWS: Record<string, ComponentType> = {
  features: FeaturesSection,
  schedules: SchedulesSection,
  identity: IdentitySection,
  saving: SavingSection,
  "meaning-search": MeaningSearchSection,
  backup: BackupSection,
  machines: MachinesSection,
  clients: ClientsSection,
  service: ServiceSection,
  updates: UpdatesSection,
};

/**
 * What Settings' address shows: `index` is Settings itself (the first section beside the list, or on a narrow window
 * the list alone), `section` a section of its own, `missing` an address with no section.
 */
type SettingsPlace = "index" | "section" | "missing";

/** Whether focus has nowhere to be: on the page itself, or on something no longer on screen. */
const focusLost = (active: Element | null) => !active || active === document.body || !shownOnScreen(active);

/** Whether all of `el` shows inside the scroller `page`. */
function insideView(el: Element, page: HTMLElement | null): boolean {
  if (!page) return true;
  const box = el.getBoundingClientRect();
  const view = page.getBoundingClientRect();
  return box.top >= view.top && box.bottom <= view.bottom;
}

/**
 * Where focus goes when the address changes within Settings, or Settings opens. Chosen from the list, focus stays on
 * the list, so the next section is one key away, as long as the link is still in view at the top of the page. Arriving at a section from anywhere else (the palette, the Machine
 * panel, Back, a narrow window's list that the section replaced), the section takes focus at the top of the page.
 * Settings itself takes no focus, like any screen, except back from a section whose focus went with it: then the
 * section's link in the list has it.
 */
function useArrival(root: RefObject<HTMLElement | null>, path: string, section: string | null, place: SettingsPlace) {
  const left = useRef<string | null>(null);
  useEffect(() => {
    const came = left.current;
    left.current = place === "section" ? section : null;
    const nav = root.current?.querySelector(".settings-nav") ?? null;
    const active = document.activeElement;
    if (nav?.contains(active) && shownOnScreen(active)) {
      root.current?.scrollTo({ top: 0 });
      // A short window, where the list does not stay in view: a link that went up with the page hands focus over.
      if (insideView(active, root.current)) return;
    }
    if (place === "section" && section && revealSettingsSection(section, true)) return;
    if (came && focusLost(active) && shownOnScreen(nav)) nav.querySelector<HTMLElement>(`a[href="${settingsHref(came)}"]`)?.focus();
  }, [root, path, section, place]);
}

export function SettingsView() {
  const { path } = useLocation();
  const section = settingsSectionShown(path);
  const place: SettingsPlace = path === "/settings" ? "index" : section ? "section" : "missing";
  const Section = section ? SECTION_VIEWS[section] : undefined;
  const root = useRef<HTMLDivElement>(null);
  useArrival(root, path, section, place);
  return (
    <div ref={root} className="page settings" data-place={place}>
      <div className="page-header">
        <h1>Settings</h1>
      </div>
      <div className="settings-layout">
        <SettingsNav current={section} />
        <div className="settings-body">
          <Link to="/settings" className="back-link settings-back">
            <span aria-hidden>←</span> All settings
          </Link>
          {Section ? (
            <Section key={section} />
          ) : (
            <p className="settings-missing" role="status">
              There is no Settings section at this address. Choose one from the list.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
