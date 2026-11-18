import { Fragment, useId, useRef } from "react";
import { SHORTCUT_GROUPS } from "../shortcuts.ts";
import { useModalDialog } from "./dialog.ts";

/** Behind `?`: every keyboard shortcut, from the same keymap the shell listens with. */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
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
        <table key={g.title} className="shortcut-table">
          <caption>{g.title}</caption>
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
      ))}
    </dialog>
  );
}
