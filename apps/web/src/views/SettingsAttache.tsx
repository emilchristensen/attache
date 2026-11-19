import { useEffect, useState } from "react";
import type { Config } from "@attache/contracts";
import { patch, post } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, useAction } from "../components/ui.tsx";
import { FeatureList, type Caps } from "./FeatureList.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** GET /config, as Schedules and Identity read it. */
function useConfig() {
  return useResource<{ config: Config }>("/config", ["config.changed"]);
}

export function FeaturesSection() {
  const caps = useResource<Caps>("/capabilities", ["config.changed", "connections.changed"]);
  return (
    <SettingsSection id="features" lede="What Attache does. Turning a feature off stops its schedules and cancels its queued work.">
      {caps.loading && !caps.data && <Loading />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {caps.data && <FeatureList caps={caps.data} onChanged={caps.reload} />}
    </SettingsSection>
  );
}

function SchedulesForm({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const [s, setS] = useState(config.schedules);
  const [n, setN] = useState(config.notifications.desktop);
  const { busy, run } = useAction();
  useEffect(() => setS(config.schedules), [config.schedules]);
  return (
    <div className="card stack">
      <div className="grid-2">
        <label className="field">
          Refresh sources every (minutes)
          <input type="number" min={5} max={1440} value={s.refreshEveryMinutes} onChange={(e) => setS({ ...s, refreshEveryMinutes: Math.max(5, Number(e.target.value) || 30) })} />
        </label>
        <label className="field">
          Daily briefing at
          <input type="time" value={s.briefingAt} disabled={!s.briefingEnabled} onChange={(e) => setS({ ...s, briefingAt: e.target.value })} />
        </label>
      </div>
      <label className="check small">
        <input type="checkbox" checked={s.briefingEnabled} onChange={(e) => setS({ ...s, briefingEnabled: e.target.checked })} /> Prepare a daily briefing
      </label>
      <label className="check small">
        <input type="checkbox" checked={n} onChange={(e) => setN(e.target.checked)} /> Desktop notification for new urgent items
      </label>
      <div>
        <button className="primary" disabled={busy !== null} onClick={() => run("s", () => patch("/config", { schedules: s, notifications: { desktop: n } }).then(onSaved), "Saved")}>
          Save
        </button>
      </div>
    </div>
  );
}

export function SchedulesSection() {
  const cfg = useConfig();
  return (
    <SettingsSection id="schedules" lede="When Attache reads your sources and prepares the daily briefing. Schedules run in the Attache service, not the browser; missed runs are caught up once when this Machine wakes.">
      {cfg.loading && !cfg.data && <Loading lines={2} />}
      <ErrorState error={cfg.error} retry={cfg.reload} />
      {cfg.data && <SchedulesForm config={cfg.data.config} onSaved={cfg.reload} />}
    </SettingsSection>
  );
}

function IdentityForm({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const [name, setName] = useState(config.identity?.name ?? "");
  const [email, setEmail] = useState(config.identity?.email ?? "");
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const save = () =>
    run(
      "id",
      () =>
        post("/setup/identity", { name, email, confirm: true }).then(() => {
          setConfirm(false);
          onSaved();
        }),
      "Identity saved",
    );
  return (
    <div className="card stack">
      <div className="grid-2">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      </div>
      <label className="check small">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I want to change my protected identity record
      </label>
      <div>
        <button disabled={!confirm || !name.trim() || busy !== null} onClick={save}>
          Save identity
        </button>
      </div>
    </div>
  );
}

export function IdentitySection() {
  const cfg = useConfig();
  return (
    <SettingsSection id="identity" lede="Your protected identity record, kept in memory/self.md. Only this form can change it; imported documents, connectors and the model cannot.">
      {cfg.loading && !cfg.data && <Loading lines={2} />}
      <ErrorState error={cfg.error} retry={cfg.reload} />
      {cfg.data && <IdentityForm config={cfg.data.config} onSaved={cfg.reload} />}
    </SettingsSection>
  );
}
