import { useRef, useState, type ReactNode } from "react";
import { CHANNEL_LABEL, settingsLockedWhileInstalling, type LastUpdateView, type UpdateChannel, type UpdateMode, type UpdatesView } from "@attache/contracts";
import { post, put } from "../api.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { ReleaseNotes } from "../components/ReleaseNotes.tsx";
import { ErrorState, Loading, Time, useAction } from "../components/ui.tsx";
import { lastCheckShown, lastUpdateShown, updatesShown } from "../updates.ts";
import { useUpdates } from "../updates-live.ts";
import { SettingsSection } from "./SettingsSection.tsx";

const MODES: ReadonlyArray<{ id: UpdateMode; label: string; description: string }> = [
  { id: "automatic", label: "Automatic", description: "Installs each Update on its own once no Job is running, then tells you what changed." },
  { id: "ask_first", label: "Ask first", description: "Downloads and checks each Update, then waits for you to select Install now." },
  { id: "off", label: "Off", description: "Never looks for Updates, so Attache makes no request about them." },
];

const CHANNELS: ReadonlyArray<{ id: UpdateChannel; label: string; description: string }> = [
  { id: "stable", label: CHANNEL_LABEL.stable, description: "Releases ready for everyday use." },
  { id: "beta", label: CHANNEL_LABEL.beta, description: "New releases first, and each Stable release that is newer." },
];

/** The day a release was published, as a date: a release's age in hours says little. */
const releasedOn = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

type Act = (key: string, fn: () => Promise<UpdatesView>, ok?: string) => Promise<unknown>;

/** Where Updates stand now: what the status means, the installed version and the last check, and what the owner can do. */
function Status({ view, busy, act }: { view: UpdatesView; busy: string | null; act: Act }) {
  const shown = updatesShown(view);
  const check = lastCheckShown(view);
  const heading = useRef<HTMLHeadingElement>(null);
  const installing = useRef<"install" | "restart">("install");
  if (shown.actions.install) installing.current = shown.actions.install;
  // The button pressed stays, disabled and as it was named, while its request runs, though the status it moves through offers it no more.
  const install = shown.actions.install ?? (busy === "install" ? installing.current : null);
  const checkNow = shown.actions.check || busy === "check";
  /** Run an action; when the status it ends in no longer offers the button that had focus, focus goes to the status. */
  const press = (key: string, fn: () => Promise<UpdatesView>) =>
    void act(key, fn).then(() =>
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) heading.current?.focus();
      }),
    );
  return (
    <section className={`card stack updates-status ${shown.tone}`} aria-labelledby="updates-status-title" data-updates-status={view.status}>
      <div className="updates-status-head" aria-live="polite">
        <h3 id="updates-status-title" ref={heading} tabIndex={-1}>
          {shown.headline}
        </h3>
        {shown.detail && <p className="small updates-detail">{shown.detail}</p>}
      </div>
      <dl className="kv">
        <dt>Installed version</dt>
        <dd data-installed-version>Attache {view.version}</dd>
        {view.status !== "unavailable" && view.status !== "off" && (
          <>
            <dt>Last check</dt>
            <dd data-last-check>
              {check ? (
                <>
                  <Time iso={check.at} standalone />
                  {check.result && `, ${check.result}`}
                </>
              ) : (
                "not yet"
              )}
            </dd>
          </>
        )}
      </dl>
      {(checkNow || install) && (
        <div className="row">
          {install && (
            <button className="primary" disabled={busy !== null} onClick={() => press("install", () => post<UpdatesView>("/updates/install"))}>
              {install === "restart" ? "Restart now" : "Install now"}
            </button>
          )}
          {checkNow && (
            <button disabled={busy !== null} onClick={() => press("check", () => post<UpdatesView>("/updates/check", { reportOnly: false }))}>
              {busy === "check" ? "Checking…" : "Check now"}
            </button>
          )}
        </div>
      )}
      {view.update && view.status !== "check_failed" && (
        <Disclosure title={`What's in Attache ${view.update.version}`} meta={`Released ${releasedOn(view.update.publishedAt)}`} className="updates-notes">
          <ReleaseNotes notes={view.update.notes} />
        </Disclosure>
      )}
    </section>
  );
}

/** What the last Update did. A rollback's detail is the installer's reason, then what became of the database. */
function LastUpdate({ last }: { last: LastUpdateView }) {
  const shown = lastUpdateShown(last);
  return (
    <section className={`card stack last-update ${shown.tone}`} aria-labelledby="last-update-title" data-last-update={last.outcome}>
      <div>
        <div className="row updates-head">
          <h3 id="last-update-title">{shown.headline}</h3>
          <span className="state-text">
            <Time iso={last.at} />
          </span>
        </div>
        {shown.detail && <p className="small last-update-detail">{shown.detail}</p>}
      </div>
      {last.outcome === "updated" && (
        <Disclosure title="What changed" className="updates-notes">
          <ReleaseNotes notes={last.notes} />
        </Disclosure>
      )}
    </section>
  );
}

/** One radio in a group of them, with what choosing it does. */
function Choice({ name, id, label, description, checked, disabled, onChoose }: { name: string; id: string; label: string; description: string; checked: boolean; disabled: boolean; onChoose: () => void }) {
  const dom = `${name}-${id}`;
  return (
    <div className="feature-row" data-choice={id}>
      <input type="radio" id={dom} name={name} checked={checked} disabled={disabled} aria-describedby={`${dom}-desc`} onChange={onChoose} />
      <div className="feature-body">
        <label htmlFor={dom} className="feature-name">
          {label}
        </label>
        <p className="desc" id={`${dom}-desc`}>
          {description}
        </p>
      </div>
    </div>
  );
}

/**
 * A setting as a group of radios. The choice shows at once, while the service saves it; if the service refuses it, the
 * group goes back to what the service holds.
 */
function ChoiceGroup<T extends string>({ name, legend, choices, value, disabled, onChoose, children }: { name: string; legend: string; choices: ReadonlyArray<{ id: T; label: string; description: string }>; value: T; disabled: boolean; onChoose: (id: T) => Promise<unknown>; children?: ReactNode }) {
  const [chosen, setChosen] = useState<T | null>(null);
  const choose = (id: T) => {
    setChosen(id);
    void onChoose(id).finally(() => setChosen(null));
  };
  return (
    <fieldset className="updates-choices">
      <legend>{legend}</legend>
      {choices.map((c) => (
        <Choice key={c.id} name={name} id={c.id} label={c.label} description={c.description} checked={(chosen ?? value) === c.id} disabled={disabled} onChoose={() => choose(c.id)} />
      ))}
      {children}
    </fieldset>
  );
}

/** This Machine's Automatic updates and Update channel; each Machine keeps its own. */
function Settings({ view, busy, act }: { view: UpdatesView; busy: string | null; act: Act }) {
  const installing = view.status === "installing";
  const disabled = busy !== null || installing;
  const mode = (id: UpdateMode) => act("mode", () => put<UpdatesView>("/updates/settings", { mode: id }), `Automatic updates: ${MODES.find((m) => m.id === id)!.label}`);
  const channel = (id: UpdateChannel) => act("channel", () => put<UpdatesView>("/updates/settings", { channel: id }), `Update channel: ${CHANNEL_LABEL[id]}`);
  return (
    <section className="card stack updates-settings" aria-labelledby="updates-settings-title">
      <div>
        <h3 id="updates-settings-title">On this Machine</h3>
        <p className="small muted">Each Machine keeps its own choice, so you can try Beta on one while the others stay on Stable.</p>
        {installing && (
          <p className="small updates-locked" data-settings-locked>
            {settingsLockedWhileInstalling(view.update?.version ?? null)}
          </p>
        )}
      </div>
      <ChoiceGroup name="update-mode" legend="Automatic updates" choices={MODES} value={view.mode} disabled={disabled} onChoose={mode} />
      <ChoiceGroup name="update-channel" legend="Update channel" choices={CHANNELS} value={view.channel} disabled={disabled} onChoose={channel}>
        <p className="help">A Machine never moves to an older version: back on Stable, it stays on its version until a Stable release passes it.</p>
      </ChoiceGroup>
    </section>
  );
}

const LEDE = "Keeps Attache current on this Machine: it looks for an Update when the service starts and every 6 hours. Every Update is checked against Attache's signature before it installs.";

export function UpdatesSection() {
  const updates = useUpdates();
  const { busy, run } = useAction();
  const view = updates.data;
  const act: Act = (key, fn, ok) => run(key, () => fn().then(updates.setData), ok);
  return (
    <SettingsSection id="updates" lede={LEDE}>
      {updates.loading && !view && (
        <div className="card">
          <Loading lines={3} />
        </div>
      )}
      <ErrorState error={updates.error} retry={updates.reload} />
      {view && (
        <>
          <Status view={view} busy={busy} act={act} />
          {view.lastUpdate && <LastUpdate last={view.lastUpdate} />}
          {view.status !== "unavailable" && <Settings view={view} busy={busy} act={act} />}
        </>
      )}
    </SettingsSection>
  );
}
