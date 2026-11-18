import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { ActionView } from "@attache/contracts";
import { post, put } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Link, Loading, useNow } from "../components/ui.tsx";
import { draftBodyKey } from "../approvals.ts";
import { draftScreen, draftTargetUrl, type DraftActionId, type DraftButton, type DraftScreen } from "../draft-state.ts";
import { connectionHref } from "../reconnect.ts";
import { approvalsHref } from "../routes.ts";
import { storedText, useDraftEditor, type DraftEditorState } from "./draft-editor.ts";
import { DRAFT_CLOCK, DraftAnswers, DraftContext, DraftHeader, DraftHistory, DraftNoticeLine, DraftReceipt, DraftSteps } from "./DraftParts.tsx";

/** What the last button press came to, said under the buttons: the service's own sentence when it refused. */
type Said = { tone: "ok" | "refused"; text: string } | null;

/** How often the page looks at the clock, so an approval that ran out reads as ended before the service says so. */
const CLOCK_TICK_MS = 15_000;

const itemId = (d: ActionView): string | null => {
  const item = (d.context as { item?: { id?: unknown } }).item;
  return typeof item?.id === "string" ? item.id : null;
};

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface Runner {
  busy: DraftActionId | null;
  run: (b: DraftButton) => void;
}

/** What each button does. Every one stays on this Draft: the page never moves to another. */
function useRunner(d: ActionView, setDraft: (d: ActionView) => void, reload: () => void, edit: DraftEditorState, setSaid: (s: Said) => void, textBox: RefObject<HTMLTextAreaElement | null>): Runner {
  const [busy, setBusy] = useState<DraftActionId | null>(null);
  const call = async (id: DraftActionId, fn: () => Promise<ActionView | null>, ok: string) => {
    setBusy(id);
    setSaid(null);
    try {
      const out = await fn();
      if (out) setDraft(out);
      setSaid({ tone: "ok", text: ok });
    } catch (e) {
      setSaid({ tone: "refused", text: (e as Error).message });
      reload();
    } finally {
      setBusy(null);
    }
  };
  const copied = async (text: string, what: string) => {
    if (await copy(text)) return setSaid({ tone: "ok", text: `Copied ${what}.` });
    textBox.current?.select();
    setSaid({ tone: "refused", text: "Could not copy. The text is selected: copy it with your keyboard." });
  };
  const v = `v${d.version}`;
  const run = (b: DraftButton) => {
    switch (b.id) {
      case "approve":
        return call("approve", () => post<ActionView>(`/actions/${d.id}/approve`, { version: d.version, payloadHash: d.payloadHash }), `Approved ${v}.`);
      case "send":
        return call("send", async () => (await post<{ action: ActionView }>(`/actions/${d.id}/execute`, { nonce: d.approval?.nonce ?? "", version: d.version, payloadHash: d.payloadHash })).action, `${b.label.replace(/^Send/, "Sending").replace(/^Create/, "Creating")}. The result shows here when it is verified.`);
      case "revoke":
        return call("revoke", () => post<ActionView>(`/actions/${d.id}/revoke`), `Revoked the approval of ${v}. Nothing was sent.`);
      case "reject":
        return call("reject", () => post<ActionView>(`/actions/${d.id}/reject`, {}), `Rejected ${v}. Nothing was sent.`);
      case "restore":
        return call(
          "restore",
          async () => {
            const out = await post<ActionView>(`/actions/${d.id}/restore`, { expectedVersion: d.version });
            edit.load(out);
            return out;
          },
          `Restored as v${d.version + 1}.`,
        );
      case "save":
        return call(
          "save",
          async () => {
            const out = await put<ActionView>(`/actions/${d.id}`, { payload: { ...d.payload, [draftBodyKey(d.kind)]: edit.text }, expectedVersion: edit.editor.baseVersion });
            edit.load(out);
            return out;
          },
          `Saved as v${edit.editor.baseVersion + 1}.`,
        );
      case "discard":
        edit.load(d);
        return setSaid({ tone: "ok", text: "Discarded your changes." });
      case "load":
        edit.load(d);
        return setSaid({ tone: "ok", text: `Loaded ${v}.` });
      case "copy":
        return void copied(storedText(d), `the text of ${v}`);
      case "copy-mine":
        return void copied(edit.text, "your text");
      case "prepare": {
        const item = itemId(d);
        if (!item) return;
        return call("prepare", async () => (await post(`/attention/${item}/draft`, {}), null), "Preparing a new Draft. It waits in Approvals when it is ready.");
      }
      default:
        return undefined;
    }
  };
  return { busy, run };
}

/** One button as the state decided it; links for the two that leave the page (the destination, Connections). */
function ActionButton({ b, d, runner, reasonId }: { b: DraftButton; d: ActionView; runner: Runner; reasonId: string | undefined }) {
  if (b.id === "open-target") {
    const url = draftTargetUrl(d);
    return url ? (
      <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
        {b.label}
      </a>
    ) : null;
  }
  if (b.id === "open-connections") {
    return (
      <Link to={connectionHref(d.connectionId ?? undefined)} className="btn">
        {b.label}
      </Link>
    );
  }
  return (
    <button className={b.primary ? "primary" : undefined} disabled={b.disabled !== null || runner.busy !== null} aria-describedby={b.disabled ? reasonId : undefined} onClick={() => runner.run(b)}>
      {b.label}
    </button>
  );
}

/** The buttons, primary first, and the reason under them for each one that waits (unless the notice says it already). */
function DraftActions({ screen, d, runner, noticeId }: { screen: DraftScreen; d: ActionView; runner: Runner; noticeId: string }) {
  const base = useId();
  const reasons = [...new Set(screen.actions.flatMap((b) => (b.disabled && !screen.notice.lines.some((l) => l.includes(b.disabled!)) ? [b.disabled] : [])))];
  const reasonId = (b: DraftButton) => (b.disabled === null ? undefined : reasons.includes(b.disabled) ? `${base}-${reasons.indexOf(b.disabled)}` : noticeId);
  if (!screen.actions.length) return null;
  return (
    <>
      <div className="draft-actions" data-draft-actions>
        {screen.actions.map((b) => (
          <ActionButton key={b.id} b={b} d={d} runner={runner} reasonId={reasonId(b)} />
        ))}
      </div>
      {reasons.map((r, i) => (
        <p key={r} className="draft-reason" id={`${base}-${i}`}>
          {r}
        </p>
      ))}
    </>
  );
}

function DraftBody({ d, setDraft, reload }: { d: ActionView; setDraft: (d: ActionView) => void; reload: () => void }) {
  useNow(CLOCK_TICK_MS);
  const edit = useDraftEditor(d);
  const [said, setSaid] = useState<Said>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const runner = useRunner(d, setDraft, reload, edit, setSaid, textBox);
  const screen = draftScreen({ draft: d, editor: edit.editor, now: Date.now(), clock: DRAFT_CLOCK });
  const noticeId = useId();
  const boxId = useId();
  // A focused button can leave with the state it belonged to (after a press, or when the Draft changes under it):
  // focus then goes to the next step, never to the page's end. Arriving on the page takes no focus.
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const gone = lastFocused.current;
    if (runner.busy !== null || !gone || gone.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const next = title.current?.querySelector<HTMLElement>("[data-draft-actions] button:not(:disabled), [data-draft-actions] a");
    (next ?? title.current?.querySelector<HTMLElement>("h1"))?.focus();
  });
  const preparedByModel = Boolean((d.context as { preparedBy?: unknown }).preparedBy);
  return (
    <div className="draft-page-body" ref={title} data-action-id={d.id} data-status={d.status} data-draft-state={screen.state} onFocus={(e) => (lastFocused.current = e.target)}>
      <DraftHeader d={d} screen={screen} />
      {screen.steps && <DraftSteps steps={screen.steps} />}
      <DraftAnswers d={d} />
      <div className="draft-editor">
        <label className="draft-label" htmlFor={boxId}>
          Text of v{edit.editor.baseVersion}
        </label>
        <textarea
          id={boxId}
          ref={textBox}
          className="draft-box"
          value={edit.text}
          rows={10}
          readOnly={screen.editor === "off"}
          aria-describedby={noticeId}
          onChange={(e) => edit.setText(e.target.value)}
          placeholder={preparedByModel || screen.editor === "off" ? "" : "No model prepared this Draft. Write it here."}
        />
      </div>
      <DraftNoticeLine notice={screen.notice} id={noticeId} />
      <DraftReceipt d={d} />
      <DraftActions screen={screen} d={d} runner={runner} noticeId={noticeId} />
      <p className="draft-said" data-tone={said?.tone} role="status">
        {said?.text}
      </p>
      <DraftContext d={d} />
      <DraftHistory d={d} />
    </div>
  );
}

/**
 * A Draft's own page at `/approvals/<id>`, where it is edited, approved and sent. Approvals stays selected in the
 * navigation, and every action keeps the page on this Draft.
 */
export function DraftPage({ id }: { id: string }) {
  const a = useResource<ActionView>(`/actions/${id}`, ["actions.changed"]);
  return (
    <div className="page">
      <div className="draft-page">
        <Link to={approvalsHref()} className="back-link">
          <span aria-hidden>←</span> Back to Approvals
        </Link>
        {a.data ? <DraftBody d={a.data} setDraft={a.setData} reload={a.reload} /> : a.error ? <ErrorState error={a.error} retry={a.reload} /> : <Loading lines={6} />}
      </div>
    </div>
  );
}
