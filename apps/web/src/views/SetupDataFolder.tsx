import { useEffect, useRef, useState } from "react";
import { plural, type Config, type SetupDefaults } from "@attache/contracts";
import { post, type ApiError } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, useAction } from "../components/ui.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { FieldError, fieldProps, focusField } from "../components/FieldError.tsx";
import { JoinForm } from "./Replication.tsx";
import { SetupActions } from "./SetupActions.tsx";
import { dataFolderProblems, type DataFolderField } from "./form-checks.ts";

interface Preview {
  path: string;
  exists: boolean;
  writable: boolean;
  markdownFiles: number;
  sample: string[];
  willCreate: string[];
  willModify: string[];
  note: string;
}

interface ImportPreview {
  path: string;
  filesToRead: number;
  sample: string[];
  skippedCount: number;
  note: string;
}

/**
 * Setup's first step. The data folder and Continue come first; importing a notes folder, the owner's identity and
 * joining another Machine's Brain are optional disclosures below. Continue names the first problem beside its field
 * and puts focus there, opening its disclosure if it is closed.
 */
export function DataFolderStep({ config, onNext }: { config: Config; onNext: () => void }) {
  const defaults = useResource<SetupDefaults>("/setup/defaults");
  const [path, setPath] = useState(config.dataFolder ?? "");
  const [preview, setPreview] = useState<{ folder: string; result: Preview } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [name, setName] = useState(config.identity?.name ?? "");
  const [email, setEmail] = useState(config.identity?.email ?? "");
  const [importPath, setImportPath] = useState("");
  const [importPreview, setImportPreview] = useState<{ folder: string; result: ImportPreview } | null>(null);
  const [attempted, setAttempted] = useState(false);
  // What Join found wrong with the data folder, until the folder changes.
  const [joinFolderProblem, setJoinFolderProblem] = useState<string | null>(null);
  const { busy, run } = useAction();
  const fields = { folder: useRef<HTMLInputElement>(null), import: useRef<HTMLInputElement>(null), name: useRef<HTMLInputElement>(null) };
  // Once the owner is in the field, a suggestion that arrives late would mix into what they type.
  const [ownersChoice, setOwnersChoice] = useState(false);
  useEffect(() => {
    if (!path && !ownersChoice && defaults.data) setPath(defaults.data.suggestion);
  }, [defaults.data, path, ownersChoice]);
  const form = { folder: path, preview: preview && { folder: preview.folder, writable: preview.result.writable }, importFolder: importPath, importPreview: importPreview && { folder: importPreview.folder }, name, email };
  const problems = attempted ? dataFolderProblems(form) : [];
  const message = (f: DataFolderField) => problems.find((p) => p.field === f)?.message ?? (f === "folder" ? joinFolderProblem : undefined);
  // A preview counts only while its field still holds the folder it was asked for: a late answer for a changed field is dropped.
  const currentPreview = preview && preview.folder === path ? preview : null;
  const currentImport = importPreview && importPath.trim() && importPreview.folder === importPath ? importPreview : null;
  const doPreview = async () => {
    setErr(null);
    const folder = path;
    try {
      setPreview({ folder, result: await post<Preview>("/setup/data-folder/preview", { path: folder }) });
    } catch (e) {
      setPreview(null);
      setErr(e as ApiError);
    }
  };
  const save = () => {
    const found = dataFolderProblems(form);
    setAttempted(true);
    if (found.length) return focusField(fields[found[0]!.field].current);
    void run("save", async () => {
      await post("/setup/data-folder", { path });
      if (name.trim()) await post("/setup/identity", { name: name.trim(), email: email.trim(), confirm: true });
      if (currentImport) await post("/import", { path: currentImport.result.path });
      onNext();
    });
  };
  return (
    <section className="stack">
      <h1>Where should Attache keep your knowledge?</h1>
      <p className="muted">Attache stores memory as plain Markdown in a folder you choose. You can open it in Obsidian or any editor. Settings, jobs and credentials stay outside this folder.</p>
      <div className="card stack">
        <div className="field-group">
          <label className="field" htmlFor="data-folder">
            Data folder
          </label>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              id="data-folder"
              ref={fields.folder}
              value={path}
              onFocus={() => setOwnersChoice(true)}
              onChange={(e) => {
                setPath(e.target.value);
                setPreview(null);
                setJoinFolderProblem(null);
              }}
              spellCheck={false}
              {...fieldProps("data-folder-error", message("folder"), "folder-help")}
            />
            <button type="button" onClick={doPreview} disabled={!path.trim()}>
              Preview
            </button>
          </div>
          <FieldError id="data-folder-error" message={message("folder")} />
          <span className="help" id="folder-help">
            A new or existing folder. Existing Markdown files are indexed but never modified.
          </span>
        </div>
        <ErrorState error={err} />
        {currentPreview && (
          <div className={`state ${currentPreview.result.writable ? "partial" : "error"}`} style={{ borderColor: currentPreview.result.writable ? "var(--line)" : undefined }} aria-live="polite">
            <strong style={{ color: "var(--ink)" }}>
              {currentPreview.result.exists ? "Existing folder" : "New folder"}: {currentPreview.result.path}
            </strong>
            <span className="small">{currentPreview.result.note}</span>
            {currentPreview.result.willCreate.length > 0 && <span className="small">Will create: {currentPreview.result.willCreate.join(", ")}</span>}
            <span className="small">Will modify: {currentPreview.result.willModify.length ? currentPreview.result.willModify.join(", ") : "nothing"}</span>
            {!currentPreview.result.writable && <span className="error-text small">Attache cannot write here. Choose another folder.</span>}
          </div>
        )}
      </div>
      <SetupActions>
        <div style={{ flex: 1 }} />
        <button className="primary" onClick={save} disabled={busy !== null}>
          {busy ? "Saving…" : "Use this folder"}
        </button>
      </SetupActions>
      <div className="setup-optional">
        <Disclosure title="Import an existing Markdown folder or Obsidian vault" meta="Optional. Read in place when you use the folder above; nothing in it is changed.">
          <div className="field-group">
            <label className="field" htmlFor="import-folder">
              Folder to import
            </label>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                id="import-folder"
                ref={fields.import}
                value={importPath}
                onChange={(e) => {
                  setImportPath(e.target.value);
                  setImportPreview(null);
                }}
                placeholder={defaults.data?.examples.notes}
                spellCheck={false}
                {...fieldProps("import-folder-error", message("import"), "import-folder-help")}
              />
              <button type="button" disabled={!importPath.trim()} onClick={() => run("ip", async () => setImportPreview({ folder: importPath, result: await post<ImportPreview>("/import/preview", { path: importPath }) }))}>
                Preview import
              </button>
            </div>
            <FieldError id="import-folder-error" message={message("import")} />
            <span className="help" id="import-folder-help">
              Attache reads it in place and cites it. It does not copy, change or move anything in that folder.
            </span>
          </div>
          {currentImport && <ImportSummary preview={currentImport.result} />}
        </Disclosure>
        <Disclosure title="Who is this for?" meta="Optional. Tells your own messages from others'." open={!!(config.identity?.name || config.identity?.email)}>
          <p className="small muted">Saved with the folder as a protected identity record that only Settings can change.</p>
          <div className="grid-2">
            <div className="field-group">
              <label className="field" htmlFor="identity-name">
                Name
              </label>
              <input id="identity-name" ref={fields.name} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" {...fieldProps("identity-name-error", message("name"))} />
              <FieldError id="identity-name-error" message={message("name")} />
            </div>
            <div className="field-group">
              <label className="field" htmlFor="identity-email">
                Email
              </label>
              <input id="identity-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
          </div>
        </Disclosure>
        <Disclosure className="join-brain" title="Already use Attache on another Machine?" meta="Join its Brain instead of starting a new one.">
          <JoinForm
            folder={path}
            primary={false}
            onFolderProblem={(text) => {
              setJoinFolderProblem(text);
              focusField(fields.folder.current);
            }}
            intro="With Replication set up on your other Machine, Attache clones that Brain into the data folder above, which must be empty or new. Leave the import and identity as they are: they come with the Brain."
            onDone={onNext}
          />
        </Disclosure>
      </div>
    </section>
  );
}

function ImportSummary({ preview }: { preview: ImportPreview }) {
  return (
    <div className="state partial small">
      <strong style={{ color: "var(--ink)" }}>
        Will read {plural(preview.filesToRead, "Markdown file")} from {preview.path}
      </strong>
      <span>{preview.note}</span>
      {preview.skippedCount > 0 && <span>{plural(preview.skippedCount, "item")} skipped (hidden folders, links or large files).</span>}
      {preview.sample.length > 0 && (
        <span className="mono">
          {preview.sample.slice(0, 5).join(", ")}
          {preview.filesToRead > 5 ? ", …" : ""}
        </span>
      )}
      <span>Files changed in that folder: 0</span>
    </div>
  );
}
