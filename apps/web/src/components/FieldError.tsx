import { Icon } from "./icons.tsx";

/**
 * A form's message about one field, shown below it with a warning glyph and the word, never colour alone.
 * The field names it with `aria-describedby` and sets `aria-invalid`; see `fieldProps`.
 */
export function FieldError({ id, message }: { id: string; message: string | null | undefined }) {
  if (!message) return null;
  return (
    <span className="field-error" id={id}>
      <Icon name="warning" size={16} />
      {message}
    </span>
  );
}

/** The attributes a field takes for its help line and its message, so a screen reader reads both. */
export function fieldProps(errorId: string, message: string | null | undefined, helpId?: string): { "aria-invalid"?: true; "aria-describedby"?: string } {
  const describedBy = [message ? errorId : null, helpId].filter(Boolean).join(" ");
  return { ...(message ? { "aria-invalid": true as const } : {}), ...(describedBy ? { "aria-describedby": describedBy } : {}) };
}

/** Put focus in a field a form found a problem with, opening the disclosure it sits in first. */
export function focusField(field: HTMLElement | null | undefined): void {
  if (!field) return;
  const closed = field.closest("details");
  if (closed && !closed.open) closed.open = true;
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: "center" });
}
