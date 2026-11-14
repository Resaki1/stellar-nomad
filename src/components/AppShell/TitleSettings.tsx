"use client";

import { useEffect, useRef, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { ChevronLeft } from "lucide-react";
import Panel from "@/components/HUD/Shell/Panel";
import AudioSettings from "@/components/HUD/SettingsMenu/AudioSettings";
import { ControlsSettings, GraphicsSettings } from "@/components/HUD/SettingsMenu/SettingsSections";
import { settingsAtom } from "@/store/store";
import { resetKeybindsAtom } from "@/store/keybinds";
import "@/components/HUD/SettingsMenu/SettingsMenu.scss";

type Section = "graphics" | "audio" | "controls";
const SECTIONS: Section[] = ["graphics", "audio", "controls"];

/** The settings sections that work without a world loaded; dev tools and save actions need the game. */
export default function TitleSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useAtom(settingsAtom);
  const resetKeybinds = useSetAtom(resetKeybindsAtom);
  const [section, setSection] = useState<Section | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section === null) navRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [section]);

  return (
    <Panel
      title={section ? section.charAt(0).toUpperCase() + section.slice(1) : "Settings"}
      eyebrow={section ? "Settings" : undefined}
      tier={2}
      width={560}
      onClose={section ? () => setSection(null) : onClose}
      secondaryAction={{
        label: "Back",
        icon: <ChevronLeft size={14} strokeWidth={1.75} aria-hidden />,
        variant: "subtle",
        onClick: section ? () => setSection(null) : onClose,
      }}
    >
      <div className="settings-menu">
        {section === null ? (
          <div className="settings-menu__nav" ref={navRef}>
            {SECTIONS.map((s) => (
              <button key={s} data-sfx="soft" className="settings-menu__button" onClick={() => setSection(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : (
          <div className="settings-menu__content">
            {section === "graphics" && <GraphicsSettings settings={settings} setSettings={setSettings} />}
            {section === "audio" && <AudioSettings />}
            {section === "controls" && (
              <ControlsSettings settings={settings} setSettings={setSettings} onResetKeybinds={() => resetKeybinds()} />
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
