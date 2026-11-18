import { useEffect } from "react";
import { navigate, useLocation } from "../components/ui.tsx";
import { Tabs, tabId, type TabItem } from "../components/Tabs.tsx";
import { useSignals } from "../nav-signals.ts";
import { approvalsHref, draftAt, draftHref, type ApprovalsTab } from "../routes.ts";
import { ApprovalsFinished } from "./ApprovalsFinished.tsx";
import { ApprovalsWaiting } from "./ApprovalsWaiting.tsx";
import { useApprovalsVisit } from "./approvals-visit.ts";
import { DraftPage } from "./DraftPage.tsx";

const PANEL = "approvals-panel";

/**
 * Approvals: everything Attache prepared that waits for the owner's OK. Waiting holds Drafts to send and Changes to
 * the Brain (and In progress), Finished what happened to the rest. A Draft's own page lives under it at
 * `/approvals/<id>`.
 */
export function ApprovalsView() {
  const loc = useLocation();
  const draft = draftAt(loc.path);
  // The interim link from before the Draft's own page (`/approvals?id=`), still used by older callers.
  const legacy = loc.search.get("id");
  useEffect(() => {
    if (legacy) navigate(draftHref(legacy), { replace: true });
  }, [legacy]);
  const signals = useSignals();
  // What was decided in this visit stays in place across the tabs and a Draft's page; leaving Approvals ends the visit.
  const visit = useApprovalsVisit();
  if (draft) return <DraftPage id={draft} />;
  const tab: ApprovalsTab = loc.search.get("tab") === "finished" ? "finished" : "waiting";
  const count = signals.badges.approvals;
  const tabs: ReadonlyArray<TabItem<ApprovalsTab>> = [
    { id: "waiting", label: "Waiting", ...(count ? { count } : {}) },
    { id: "finished", label: "Finished" },
  ];
  return (
    <div className="page">
      <div className="approvals">
        <div className="page-header">
          <h1>Approvals</h1>
          <span className="subtitle">What Attache prepared that waits for your OK: Drafts to send and changes to the Brain.</span>
        </div>
        <Tabs label="Approvals" tabs={tabs} selected={tab} onSelect={(t) => navigate(approvalsHref(t))} panelId={PANEL} />
        <div id={PANEL} role="tabpanel" aria-labelledby={tabId(PANEL, tab)} className="approvals-panel">
          {tab === "waiting" ? <ApprovalsWaiting visit={visit} /> : <ApprovalsFinished />}
        </div>
      </div>
    </div>
  );
}
