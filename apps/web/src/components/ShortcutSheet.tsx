import { Fragment, useId, useRef } from "react";
import { SHORTCUT_GROUPS } from "../shortcuts.ts";
import { useDecisionKeys } from "../decision-keys.ts";
import { useModalDialog } from "./dialog.ts";

/** The switch for the Inbox's decision keys, off until the owner turns it on. */
function DecisionKeysSwitch({ on, setOn }: { on: boolean; setOn: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="shortcut-switch">
      <input type="checkbox" id={id} checked={on} onChange={(e) => setOn(e.target.checked)} aria-describedby={`${id}-desc`} />
      <label htmlFor={id}>Use the decision keys</label>
      <p id={`${id}-desc`} className="small muted">
        {on ? "On in this browser. Each decision keeps Undo in its row." : "Off, so a stray key never changes your Inbox."}
      </p>
    </div>
  );
}

/** Behind `?`: every keyboard shortcut, from the same keymap the shell listens with. */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [decisions, setDecisions] = useDecisionKeys();
  useModalDialog(ref, open, onClose);
  return (
    <dialog ref={ref} className="sheet shortcut-sheet" aria-labelledby={title}>
      <div className="sheet-head">
        <h2 id={title} className="sheet-title">
          Keyboard shortcuts
        </h2>
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted">They work anywhere outside a text field or an open dialog.</p>
      {SHORTCUT_GROUPS.map((g) => (
        <Fragment key={g.title}>
          <table className="shortcut-table">
            <caption>{g.switchable ? `${g.title}, ${decisions ? "on" : "off"}` : g.title}</caption>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.keys.join(" ")}>
                  <th scope="row">
                    {r.keys.map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && " then "}
                        <kbd>{k}</kbd>
                      </Fragment>
                    ))}
                  </th>
                  <td>{r.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {g.switchable && <DecisionKeysSwitch on={decisions} setOn={setDecisions} />}
        </Fragment>
      ))}
    </dialog>
  );
}
