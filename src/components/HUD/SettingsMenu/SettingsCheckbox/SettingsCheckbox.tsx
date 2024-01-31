import { SetAtom } from "@/store/store";
import { SetStateAction } from "jotai";
import "./SettingsCheckbox.scss";

type SettingsCheckboxProps = {
  active: boolean;
  onChange: SetAtom<[SetStateAction<any>], void>;
  label: string;
};

const SettingsCheckbox = (props: SettingsCheckboxProps) => {
  return (
    <div
      className="settings-checkbox__container"
      onClick={props.onChange}
      tabIndex={1}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          props.onChange({});
        }
      }}
    >
      <label className="settings-checkbox__label" htmlFor={props.label}>
        {props.label}
      </label>
      <input
        className="settings-checkbox__input"
        type="checkbox"
        id={props.label}
        checked={props.active}
        onChange={props.onChange}
      />
      <div className="settings-checkbox__indicator">
        {props.active && <div className="settings-checkbox__indicator-fill" />}
      </div>
    </div>
  );
};

export default SettingsCheckbox;
