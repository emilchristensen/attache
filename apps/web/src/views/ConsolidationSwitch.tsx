import type { ConsolidationSettingView } from "@attache/contracts";
import { put } from "../api.ts";
import { useResource } from "../live.ts";
import { SwitchRow } from "../components/SwitchRow.tsx";
import { ErrorState, Loading, useAction } from "../components/ui.tsx";

/** Consolidation's switch, beside the Harness switches: on, what it finds is written without review, on this Machine only. */
export function ConsolidationSwitch() {
  const setting = useResource<ConsolidationSettingView>("/consolidation", ["config.changed"]);
  const { busy, run } = useAction();
  const toggle = (on: boolean) =>
    void run("consolidation", () => put("/consolidation/auto-accept", { autoAccept: on }).then(setting.reload), on ? "Consolidation writes without asking on this Machine" : "Consolidation makes Proposals on this Machine");
  if (setting.loading && !setting.data) return <Loading lines={1} />;
  if (!setting.data) return <ErrorState error={setting.error} retry={setting.reload} />;
  const on = setting.data.autoAccept;
  return (
    <SwitchRow
      id="auto-accept-consolidation"
      label="Consolidation"
      description={on ? "Writes what it finds in finished sessions and meetings without asking." : "Makes Proposals for you to review instead."}
      checked={on}
      disabled={busy !== null}
      onChange={toggle}
      data={{ "data-consolidation": "" }}
    />
  );
}
