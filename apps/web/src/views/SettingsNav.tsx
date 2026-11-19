import { useSignals } from "../nav-signals.ts";
import { settingsGroups, settingsHref } from "../routes.ts";
import { AttentionDot } from "../components/AttentionDot.tsx";
import { Icon } from "../components/icons.tsx";
import { spokenName } from "../components/ScreenLink.tsx";
import { Link } from "../components/ui.tsx";

/** The section that carries Settings' named warning (a Replication problem), in the list as in the navigation. */
const WARNING_SECTION = "machines";

/**
 * Settings' section list: four named groups of links, the section on screen marked as the current page. Beside the
 * section on a wide window; on a narrow one it is Settings' first screen and a section replaces it.
 */
export function SettingsNav({ current }: { current: string | null }) {
  const warning = useSignals().settingsWarning;
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {settingsGroups().map(({ group, sections }) => (
        <div key={group} className="settings-nav-group" role="group" aria-labelledby={`settings-group-${group}`}>
          <p className="settings-nav-title" id={`settings-group-${group}`}>
            {group}
          </p>
          <ul>
            {sections.map((s) => {
              const problem = s.id === WARNING_SECTION ? warning : null;
              return (
                <li key={s.id}>
                  <Link to={settingsHref(s.id)} aria-current={s.id === current ? "page" : undefined} aria-label={problem ? spokenName(s.label, [problem]) : undefined}>
                    <span className="settings-nav-label">{s.label}</span>
                    {problem && (
                      <span className="settings-nav-warning">
                        <AttentionDot decorative />
                        {problem}
                      </span>
                    )}
                    <Icon name="chevron" size={16} className="settings-nav-chevron" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
