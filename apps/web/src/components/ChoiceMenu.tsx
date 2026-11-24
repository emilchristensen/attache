import { Icon } from "./icons.tsx";
import { usePopover } from "./menu.ts";

export interface Choice<T extends string> {
  id: T;
  label: string;
  /** A number shown at the end of the choice, such as how many rows it lists. */
  count?: number;
}

interface Props<T extends string> {
  /** What the menu chooses, as a screen reader hears it before the button's words ("Type"); the group's name too. */
  name: string;
  /** The button's words: the choice made, or the menu's own name. */
  shown: string;
  choices: ReadonlyArray<Choice<T>>;
  chosen: T;
  onChoose: (id: T) => void;
}

/**
 * One choice behind a small button that opens a menu under it, as the Inbox heading's "All types" and "View options"
 * do. The chosen entry is pressed and carries a check; a choice closes the menu and returns focus to its button.
 */
export function ChoiceMenu<T extends string>({ name, shown, choices, chosen, onChoose }: Props<T>) {
  const menu = usePopover();
  // The visible words lead the name when they say the menu's name already (WCAG 2.5.3).
  const prefix = shown.startsWith(name) ? null : `${name}: `;
  return (
    <div className="choice-menu">
      <button className="small choice-menu-trigger" {...menu.buttonProps}>
        {prefix && <span className="sr-only">{prefix}</span>}
        {shown}
        <Icon name="chevron" size={12} className="choice-menu-caret" />
      </button>
      {menu.open && (
        <div className="menu-pop choice-menu-pop" aria-label={name} {...menu.listProps}>
          {choices.map((c) => (
            <button key={c.id} className="menu-item choice-menu-item" aria-pressed={c.id === chosen} onClick={() => onChoose(c.id)}>
              <Icon name="check" size={14} className="choice-menu-check" />
              <span className="choice-menu-label">{c.label}</span>
              {c.count !== undefined && (
                <>
                  {" "}
                  <span className="choice-menu-count">{c.count}</span>
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
