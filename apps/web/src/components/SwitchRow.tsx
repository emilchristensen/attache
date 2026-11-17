/**
 * One on/off switch in a list of them, with its name and what it does now:
 * a Harness's auto-accept, or Consolidation's. `data` names the row for tests
 * and styles, such as `{ "data-harness": "codex" }`.
 */
export function SwitchRow({ id, label, description, checked, disabled, onChange, data }: { id: string; label: string; description: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void; data: Record<`data-${string}`, string> }) {
  return (
    <div className="feature-row" {...data}>
      <input type="checkbox" id={id} checked={checked} disabled={disabled} aria-describedby={`${id}-desc`} onChange={(e) => onChange(e.target.checked)} />
      <div style={{ flex: 1 }}>
        <label htmlFor={id} style={{ cursor: "pointer" }}>
          <strong>{label}</strong>
        </label>
        <p className="desc" id={`${id}-desc`}>
          {description}
        </p>
      </div>
    </div>
  );
}
