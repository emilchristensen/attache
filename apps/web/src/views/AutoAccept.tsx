import type { HarnessSettingView } from "@attache/contracts";
import { put } from "../api.ts";
import { useResource } from "../live.ts";
import { SwitchRow } from "../components/SwitchRow.tsx";
import { ErrorState, Link, Loading, useAction } from "../components/ui.tsx";
import { ConsolidationSwitch } from "./ConsolidationSwitch.tsx";

/** One switch per connected Harness, on unless the owner switched it off: on, its saves are written without the confirmation request, on this Machine only. */
export function AutoAccept() {
  const list = useResource<HarnessSettingView[]>("/harnesses", ["config.changed", "connections.changed"]);
  const { busy, run } = useAction();
  const toggle = (h: HarnessSettingView, on: boolean) =>
    void run(h.id, () => put(`/harnesses/${h.id}/auto-accept`, { autoAccept: on }).then(list.reload), on ? `${h.label} saves without asking on this Machine` : `${h.label} asks before every save`);
  return (
    <section className="card stack" aria-labelledby="auto-accept-title">
      <h3 id="auto-accept-title">Auto-accept</h3>
      <p className="small muted">
        A connected Harness writes its saves to your Brain without review. Switch it off and it asks you to confirm every save first, on this Machine only. Your identity record is never changed this way, and every change written without review shows on Home under Recently added for 7 days, where you can revert it.
      </p>
      {list.loading && !list.data && <Loading lines={1} />}
      <ErrorState error={list.error} retry={list.reload} />
      {list.data && list.data.length === 0 && (
        <p className="small muted">
          No Harness is connected. Connect one under <Link to="/connections">Connections</Link>.
        </p>
      )}
      <div>
        {list.data?.map((h) => (
          <SwitchRow key={h.id} id={`auto-accept-${h.id}`} label={h.label} description={h.autoAccept ? "Saves without asking." : "Asks before every save."} checked={h.autoAccept} disabled={busy !== null} onChange={(on) => toggle(h, on)} data={{ "data-harness": h.id }} />
        ))}
        <ConsolidationSwitch />
      </div>
    </section>
  );
}
