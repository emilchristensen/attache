import { ProposalReview } from "../components/ProposalReview.tsx";
import { DraftsSection } from "./Drafts.tsx";

/**
 * Approvals: everything Attache prepared that waits for the owner's OK, under one heading. For now it holds the
 * Drafts list and the Proposals list as they were; the Waiting and Finished tabs come with #27 of spec #14.
 */
export function ApprovalsView() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Approvals</h1>
        <span className="subtitle">Drafts to send and changes to the Brain that wait for your OK.</span>
      </div>
      <div className="approvals-sections">
        <DraftsSection />
        <ProposalReview />
      </div>
    </div>
  );
}
