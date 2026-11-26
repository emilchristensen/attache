import { useId, useRef, useState } from "react";
import type { UpdatesView } from "@attache/contracts";
import { post } from "../api.ts";
import { settingsHref } from "../routes.ts";
import { updateLine, type UpdateLine as Line, type UpdateLineAction } from "../update-line.ts";
import { useUpdates } from "../updates-live.ts";
import { useModalDialog } from "./dialog.ts";
import { Icon, type IconName } from "./icons.tsx";
import { ReleaseNotes } from "./ReleaseNotes.tsx";
import { Link, useAction, useNow } from "./ui.tsx";

const ICON: Record<Line["state"], IconName> = { updated: "check", ready: "update", waiting_for_jobs: "update", installing: "update", rolled_back: "warning" };

/** What changed: the release notes from the signed manifest, in a dialog over the page. */
function WhatChanged({ action, describedBy }: { action: Extract<UpdateLineAction, { kind: "what_changed" }>; describedBy: string }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const title = useId();
  useModalDialog(dialog, open, () => setOpen(false), opener);
  return (
    <>
      <button ref={opener} className="ghost small" aria-describedby={describedBy} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {action.label}
      </button>
      <dialog ref={dialog} className="sheet release-notes-sheet" aria-labelledby={title}>
        <div className="sheet-head">
          <h2 id={title} className="sheet-title">
            What changed in Attache {action.version}
          </h2>
          <button className="ghost small" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        <ReleaseNotes notes={action.notes} />
      </dialog>
    </>
  );
}

/** Install or Restart now: the button pressed stays, disabled, while its request runs; the line then says Installing. */
function InstallButton({ action, describedBy, onDone }: { action: Extract<UpdateLineAction, { kind: "install" | "restart" }>; describedBy: string; onDone: (v: UpdatesView) => void }) {
  const { busy, run } = useAction();
  return (
    <button className="small primary" aria-describedby={describedBy} disabled={busy !== null} onClick={() => void run("install", () => post<UpdatesView>("/updates/install").then(onDone))}>
      {action.label}
    </button>
  );
}

function Action({ action, describedBy, onDone }: { action: UpdateLineAction; describedBy: string; onDone: (v: UpdatesView) => void }) {
  switch (action.kind) {
    case "what_changed":
      return <WhatChanged action={action} describedBy={describedBy} />;
    case "install":
    case "restart":
      return <InstallButton action={action} describedBy={describedBy} onDone={onDone} />;
    case "details":
      return (
        <Link to={settingsHref("updates")} className="btn ghost small">
          {action.label}
        </Link>
      );
  }
}

/**
 * The line under the masthead about Attache itself (`update-line.ts`), after the Connection banner, and its polite
 * announcement, which is always there so a screen reader hears each new line once. `shown` is false where the page
 * itself says it all (Settings' Updates section). The line of a finished Update goes after one day, also on an open page.
 */
export function UpdateLine({ shown }: { shown: boolean }) {
  const updates = useUpdates();
  useNow(60_000);
  const line = shown ? updateLine({ updates: updates.data, now: Date.now() }) : null;
  const textId = useId();
  const text = useRef<HTMLSpanElement>(null);
  /** After Install or Restart now, the button is gone with the line that offered it: focus goes to the line's words. */
  const installed = (v: UpdatesView) => {
    updates.setData(v);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) text.current?.focus();
    });
  };
  return (
    <>
      {line && (
        <section className={`update-line banner ${line.tone === "danger" ? "danger" : "news"}`} aria-label="Update" data-update-line data-state={line.state}>
          <Icon name={ICON[line.state]} />
          <span id={textId} ref={text} className="update-line-text" tabIndex={-1}>
            {line.text}
          </span>
          {line.action && <Action key={line.key} action={line.action} describedBy={textId} onDone={installed} />}
        </section>
      )}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-update-announcement>
        {line?.text ?? ""}
      </p>
    </>
  );
}
