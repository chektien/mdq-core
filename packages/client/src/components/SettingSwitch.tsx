import { useId, type ReactNode } from "react";

/**
 * One presenter setting as a row: the name and a one-line description on the left, the switch on the right.
 * The whole row is the button, so the touch target is the full width, and the description stays attached to
 * the control it explains. The state shows in words ("On" / "Off") as well as by the switch position.
 */
export default function SettingSwitch({
  label,
  description,
  checked,
  onToggle,
  disabled = false,
  title,
  className = "",
  children,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  /** Anything that belongs under the row, such as an error message. */
  children?: ReactNode;
}) {
  const descriptionId = useId();
  const labelId = useId();
  return (
    <div className={`setting-switch-wrap ${className}`.trim()}>
      <button
        type="button"
        role="switch"
        className="setting-switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        title={title}
        onClick={onToggle}
      >
        <span className="setting-switch-text">
          <span id={labelId} className="setting-switch-label">{label}</span>
          <span id={descriptionId} className="setting-switch-description">{description}</span>
        </span>
        <span className="setting-switch-state" aria-hidden="true">
          <span className="setting-switch-word">{checked ? "On" : "Off"}</span>
          <span className="setting-switch-track"><span className="setting-switch-thumb" /></span>
        </span>
      </button>
      {children}
    </div>
  );
}
