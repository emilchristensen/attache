import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { ErrorState, Loading, Time, useAction } from "../components/ui.tsx";
import { AutoAccept } from "./AutoAccept.tsx";
import { MeaningSearchCard } from "./MeaningSearch.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** Auto-accept per Harness and Consolidation together: one place answers what reaches the Brain without review. */
export function SavingSection() {
  return (
    <SettingsSection id="saving" lede="What reaches the Brain without your review, on this Machine. Everything else waits in Approvals as a Proposal.">
      <AutoAccept />
    </SettingsSection>
  );
}

export function MeaningSearchSection() {
  return (
    <SettingsSection id="meaning-search" lede="Finds notes by what they mean, so a question in other words or in Danish finds an English note. The model runs on this Machine; notes never leave it, and its vectors stay out of the Brain.">
      <MeaningSearchCard />
    </SettingsSection>
  );
}

interface Backup {
  name: string;
  path: string;
  bytes: number;
  createdAt: string;
}

export function BackupSection() {
  const list = useResource<Backup[]>("/backups");
  const { busy, run } = useAction();
  return (
    <SettingsSection id="backup" lede="A backup holds your data folder and Attache's database: settings, jobs, Drafts and receipts. Credentials stay in the secret store and are not exported; reconnect them after a restore.">
      <div className="card stack">
        <div>
          <button disabled={busy !== null} onClick={() => run("bk", () => post("/backups").then(list.reload), "Backup created")}>
            {busy ? "Creating…" : "Create backup now"}
          </button>
        </div>
        {list.loading && !list.data && <Loading lines={1} />}
        <ErrorState error={list.error} retry={list.reload} />
        {list.data &&
          (list.data.length ? (
            <ul className="backup-list">
              {list.data.map((b) => (
                <li key={b.name}>
                  <span className="mono">{b.path}</span>
                  <span className="small muted">
                    {(b.bytes / 1024).toFixed(0)} KB · <Time iso={b.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No backups yet.</p>
          ))}
      </div>
      <Disclosure title="Restore and uninstall" meta="From the command line">
        <p className="small">
          Restore into a fresh profile with <code>attache restore &lt;file&gt; --data-folder &lt;empty folder&gt;</code>.
        </p>
        <p className="small">
          Uninstall with <code>attache-uninstall</code>; it keeps your data unless you pass <code>--delete-data</code>.
        </p>
      </Disclosure>
    </SettingsSection>
  );
}
