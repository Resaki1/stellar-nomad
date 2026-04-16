import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import "./SettingsMenu.scss";
import { SetStateAction, useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  SetAtom,
  Settings,
  settingsAtom,
  settingsIsOpenAtom,
} from "@/store/store";
import SettingsCheckbox from "./SettingsCheckbox/SettingsCheckbox";
import KeybindRow from "./KeybindRow/KeybindRow";
import {
  KEYBIND_ACTIONS,
  CATEGORY_LABELS,
  KeybindCategory,
  keybindsAtom,
  resetKeybindsAtom,
} from "@/store/keybinds";
import { useDetectGPU } from "@react-three/drei";
import { useAsteroidDeltaStore } from "@/sim/asteroids/runtimeContext";
import { clearShipState, loadShipState } from "@/sim/shipPersistence";
import { devTeleportAtom, devMaxSpeedOverrideAtom, devSpeedUnitAtom } from "@/store/dev";
import { type SpeedUnit, SPEED_UNIT_TO_MPS } from "@/sim/units";
import { addAssaySamplesAtom, researchAtom } from "@/store/research";
import { addCargoAtom } from "@/store/cargo";
import { modulesAtom, addCraftedItemAtom } from "@/store/modules";
import { ITEMS, RESEARCH_NODES } from "@/data/content";
import { resetCommsPlayedAtom } from "@/store/comms";

enum SubMenu {
  Graphics = "graphics",
  Controls = "controls",
  Dev = "dev",
}

const IS_DEV = process.env.NODE_ENV === "development";

const renderSubMenu = (
  subMenu: SubMenu,
  settings: Settings,
  setSettings: SetAtom<[SetStateAction<Settings>], void>,
  onResetWorld?: () => void,
  onResetKeybinds?: () => void,
  devHandlers?: {
    onTeleport: (x: number, y: number, z: number) => void;
    onSetMaxSpeed: (speed: number | null) => void;
    currentMaxSpeedOverride: number | null;
    onGrantAssay: (amount: number) => void;
    onGrantCargo: (resourceId: string, amount: number) => void;
    onUnlockAllResearch: () => void;
    onGrantAllItems: () => void;
    onResetProgress: () => void;
    onResetComms: () => void;
  }
) => {
  switch (subMenu) {
    case SubMenu.Graphics:
      return (
        <>
          <SettingsCheckbox
            active={settings.bloom}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                bloom: !prev.bloom,
              }))
            }
            label="bloom"
          />
          <SettingsCheckbox
            active={settings.toneMapping}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                toneMapping: !prev.toneMapping,
              }))
            }
            label="AgX tone mapping"
          />
        </>
      );
    case SubMenu.Controls: {
      // Group keybind actions by category
      const categories = new Map<KeybindCategory, typeof KEYBIND_ACTIONS>();
      for (const a of KEYBIND_ACTIONS) {
        if (!categories.has(a.category)) categories.set(a.category, []);
        categories.get(a.category)!.push(a);
      }

      return (
        <>
          <SettingsCheckbox
            active={settings.invertPitch}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                invertPitch: !prev.invertPitch,
              }))
            }
            label="invert pitch"
          />

          {Array.from(categories.entries()).map(([cat, actions]) => (
            <div key={cat} className="keybind-category">
              <div className="keybind-category__title">
                {CATEGORY_LABELS[cat]}
              </div>
              <div className="keybind-category__rows">
                {actions.map((a) => (
                  <KeybindRow key={a.id} action={a.id} label={a.label} />
                ))}
              </div>
            </div>
          ))}

          {onResetKeybinds && (
            <button
              className="settings__menu-button settings__menu-button--subtle"
              onClick={onResetKeybinds}
            >
              reset keybinds
            </button>
          )}
        </>
      );
    }
    case SubMenu.Dev:
      return (
        <>
          <SettingsCheckbox
            active={settings.fps}
            onChange={() =>
              setSettings((prev) => ({
                ...prev,
                fps: !prev.fps,
              }))
            }
            label="show fps"
          />
          {devHandlers && <DevControls {...devHandlers} />}
          {onResetWorld && (
            <button
              className="settings__menu-button settings__menu-button--danger"
              onClick={onResetWorld}
            >
              reset world
            </button>
          )}
        </>
      );
  }
};

// ---------------------------------------------------------------------------
// Dev-only controls (position teleport + max speed override)
// ---------------------------------------------------------------------------

const RESOURCE_IDS = [
  "silicates",
  "fe_ni_metal",
  "carbon",
  "sulfur",
  "hydrates",
  "titanium",
  "helium_3",
] as const;

function DevControls({
  onTeleport,
  onSetMaxSpeed,
  currentMaxSpeedOverride,
  onGrantAssay,
  onGrantCargo,
  onUnlockAllResearch,
  onGrantAllItems,
  onResetProgress,
  onResetComms,
}: {
  onTeleport: (x: number, y: number, z: number) => void;
  onSetMaxSpeed: (speed: number | null) => void;
  currentMaxSpeedOverride: number | null;
  onGrantAssay: (amount: number) => void;
  onGrantCargo: (resourceId: string, amount: number) => void;
  onUnlockAllResearch: () => void;
  onGrantAllItems: () => void;
  onResetProgress: () => void;
  onResetComms: () => void;
}) {
  const [posX, setPosX] = useState("");
  const [posY, setPosY] = useState("");
  const [posZ, setPosZ] = useState("");
  const [speedUnit, setSpeedUnit] = useAtom(devSpeedUnitAtom);
  const [speedVal, setSpeedVal] = useState(
    currentMaxSpeedOverride !== null
      ? String(currentMaxSpeedOverride / SPEED_UNIT_TO_MPS[speedUnit])
      : ""
  );

  // Resource grant state
  const [selectedResource, setSelectedResource] = useState<string>(RESOURCE_IDS[0]);
  const [resourceAmount, setResourceAmount] = useState("500");
  const [assayAmount, setAssayAmount] = useState("500");

  const handleLoadCurrent = () => {
    const saved = loadShipState();
    if (saved) {
      setPosX(String(Math.round(saved.positionKm[0] * 100) / 100));
      setPosY(String(Math.round(saved.positionKm[1] * 100) / 100));
      setPosZ(String(Math.round(saved.positionKm[2] * 100) / 100));
    }
  };

  const handleTeleport = () => {
    const x = parseFloat(posX);
    const y = parseFloat(posY);
    const z = parseFloat(posZ);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    onTeleport(x, y, z);
  };

  const handleUnitChange = (newUnit: SpeedUnit) => {
    const v = parseFloat(speedVal);
    if (Number.isFinite(v) && v > 0) {
      const mps = v * SPEED_UNIT_TO_MPS[speedUnit];
      setSpeedVal(String(mps / SPEED_UNIT_TO_MPS[newUnit]));
    }
    setSpeedUnit(newUnit);
  };

  const handleSpeedApply = () => {
    const v = parseFloat(speedVal);
    if (!speedVal.trim()) {
      onSetMaxSpeed(null);
      return;
    }
    if (!Number.isFinite(v) || v <= 0) return;
    onSetMaxSpeed(v * SPEED_UNIT_TO_MPS[speedUnit]);
  };

  const handleGrantCargo = () => {
    const amt = parseInt(resourceAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onGrantCargo(selectedResource, amt);
  };

  const handleGrantAllCargo = () => {
    const amt = parseInt(resourceAmount, 10) || 500;
    for (const id of RESOURCE_IDS) {
      onGrantCargo(id, amt);
    }
  };

  const handleGrantAssay = () => {
    const amt = parseInt(assayAmount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onGrantAssay(amt);
  };

  return (
    <div className="dev-controls">
      {/* Teleport */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">teleport (km)</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input"
            type="number"
            placeholder="X"
            value={posX}
            onChange={(e) => setPosX(e.target.value)}
          />
          <input
            className="dev-controls__input"
            type="number"
            placeholder="Y"
            value={posY}
            onChange={(e) => setPosY(e.target.value)}
          />
          <input
            className="dev-controls__input"
            type="number"
            placeholder="Z"
            value={posZ}
            onChange={(e) => setPosZ(e.target.value)}
          />
        </div>
        <div className="dev-controls__row">
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleLoadCurrent}
          >
            load current
          </button>
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleTeleport}
          >
            teleport
          </button>
        </div>
      </div>

      {/* Max speed */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">max speed -- default: 400 m/s</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder={String(400 / SPEED_UNIT_TO_MPS[speedUnit])}
            value={speedVal}
            onChange={(e) => setSpeedVal(e.target.value)}
          />
          <select
            className="dev-controls__select"
            value={speedUnit}
            onChange={(e) => handleUnitChange(e.target.value as SpeedUnit)}
          >
            <option value="m/s">m/s</option>
            <option value="km/s">km/s</option>
            <option value="AU/s">AU/s</option>
          </select>
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleSpeedApply}
          >
            {speedVal.trim() ? "apply" : "reset"}
          </button>
        </div>
      </div>

      {/* Grant cargo */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">grant cargo</div>
        <div className="dev-controls__row">
          <select
            className="dev-controls__select"
            value={selectedResource}
            onChange={(e) => setSelectedResource(e.target.value)}
          >
            {RESOURCE_IDS.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="500"
            value={resourceAmount}
            onChange={(e) => setResourceAmount(e.target.value)}
          />
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleGrantCargo}
          >
            add
          </button>
        </div>
        <div className="dev-controls__row">
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleGrantAllCargo}
          >
            grant all resources
          </button>
        </div>
      </div>

      {/* Grant assay samples */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">assay samples</div>
        <div className="dev-controls__row">
          <input
            className="dev-controls__input dev-controls__input--wide"
            type="number"
            placeholder="500"
            value={assayAmount}
            onChange={(e) => setAssayAmount(e.target.value)}
          />
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={handleGrantAssay}
          >
            add
          </button>
        </div>
      </div>

      {/* Progression cheats */}
      <div className="dev-controls__section">
        <div className="dev-controls__label">progression</div>
        <div className="dev-controls__row dev-controls__row--wrap">
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={onUnlockAllResearch}
          >
            unlock all research
          </button>
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={onGrantAllItems}
          >
            grant all items
          </button>
          <button
            className="settings__menu-button settings__menu-button--subtle"
            onClick={onResetComms}
          >
            reset comms
          </button>
          <button
            className="settings__menu-button settings__menu-button--danger"
            onClick={onResetProgress}
          >
            reset progress
          </button>
        </div>
      </div>
    </div>
  );
}

const SettingsMenu = () => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [isOpen, setIsOpen] = useAtom(settingsIsOpenAtom);
  const [activeSubMenu, setActiveSubMenu] = useState<SubMenu | null>(null);
  const gpu = useDetectGPU();
  const deltaStore = useAsteroidDeltaStore();

  const keybinds = useAtomValue(keybindsAtom);
  const resetKeybinds = useSetAtom(resetKeybindsAtom);

  // Dev-only atoms
  const setDevTeleport = useSetAtom(devTeleportAtom);
  const [devMaxSpeed, setDevMaxSpeed] = useAtom(devMaxSpeedOverrideAtom);
  const setAddAssay = useSetAtom(addAssaySamplesAtom);
  const setAddCargo = useSetAtom(addCargoAtom);
  const [, setResearch] = useAtom(researchAtom);
  const [, setModules] = useAtom(modulesAtom);
  const setAddCraftedItem = useSetAtom(addCraftedItemAtom);
  const resetComms = useSetAtom(resetCommsPlayedAtom);

  const availableSubMenus = useMemo(
    () =>
      Object.values(SubMenu).filter(
        (s) => s !== SubMenu.Dev || IS_DEV
      ),
    []
  );

  const devHandlers = useMemo(
    () =>
      IS_DEV
        ? {
            onTeleport: (x: number, y: number, z: number) =>
              setDevTeleport([x, y, z]),
            onSetMaxSpeed: (speed: number | null) => setDevMaxSpeed(speed),
            currentMaxSpeedOverride: devMaxSpeed,
            onGrantAssay: (amount: number) => setAddAssay(amount),
            onGrantCargo: (resourceId: string, amount: number) =>
              setAddCargo({ resourceId, amount }),
            onUnlockAllResearch: () => {
              const allIds = RESEARCH_NODES.map((n) => n.id);
              setResearch((prev) => ({
                ...prev,
                completedNodes: allIds,
                activeResearch: null,
                assaySamples: prev.assaySamples + 9999,
              }));
            },
            onGrantAllItems: () => {
              for (const item of ITEMS) {
                if (item.type === "consumable") {
                  for (let i = 0; i < 5; i++) setAddCraftedItem(item.id);
                } else {
                  setAddCraftedItem(item.id);
                }
              }
            },
            onResetProgress: () => {
              setResearch({
                assaySamples: 0,
                completedNodes: [],
                activeResearch: null,
              });
              setModules({
                ownedModules: [],
                equippedModules: {},
                consumables: {},
                consumableCooldowns: {},
                hotbar: Array(10).fill(null),
              });
            },
            onResetComms: () => resetComms(),
          }
        : undefined,
    [setDevTeleport, setDevMaxSpeed, devMaxSpeed, setAddAssay, setAddCargo, setResearch, setAddCraftedItem, setModules, resetComms]
  );

  const handleResetKeybinds = useCallback(() => {
    resetKeybinds();
  }, [resetKeybinds]);

  const handleResetWorld = useCallback(() => {
    if (!window.confirm("Reset asteroid field? All mining progress will be lost.")) return;
    deltaStore.clearAll();
    clearShipState();
    localStorage.removeItem("ship-config-v1");
    localStorage.removeItem("cargo");
    localStorage.removeItem("keybinds-v1");
    localStorage.removeItem("research-v1");
    localStorage.removeItem("modules-v1");
    localStorage.removeItem("modules-v2");
    window.location.reload();
  }, [deltaStore]);

  useEffect(() => {
    const storedSettings = JSON.parse(
      localStorage.getItem("settings") ?? '{"initial": true}'
    );
    if (storedSettings.initial === true) {
      if (gpu.tier >= 2) {
        setSettings((prev) => ({
          ...prev,
          bloom: true,
          initial: false,
        }));
      }

      if (gpu.tier >= 3) {
        setSettings((prev) => ({
          ...prev,
          bloom: true,
          toneMapping: true,
          initial: false,
        }));
      }
    }
  }, []);

  const toggleMenu = useCallback(() => setIsOpen((prev) => !prev), [setIsOpen]);

  // Settings toggle hotkey — reads from keybinds store
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (keybindsRef.current.toggleSettings.includes(key)) {
        toggleMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMenu]);

  return (
    <>
      <button className="settings__open-button" onClick={toggleMenu}>
        I I
      </button>

      {isOpen && (
        <div className="settings" onClick={() => setIsOpen(false)}>
          <div className="settings__menu" onClick={(e) => e.stopPropagation()}>
            <h2 className="settings__menu-title">
              {activeSubMenu ?? "settings"}
            </h2>
            {!activeSubMenu ? (
              <>
                {availableSubMenus.map((subMenu) => (
                  <button
                    key={subMenu}
                    className="settings__menu-button"
                    onClick={() => setActiveSubMenu(subMenu)}
                  >
                    {subMenu}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button
                  className="settings__menu-button settings__menu-button--back"
                  onClick={() => setActiveSubMenu(null)}
                >
                  {"<"} back
                </button>
                {renderSubMenu(
                  activeSubMenu,
                  settings,
                  setSettings,
                  handleResetWorld,
                  handleResetKeybinds,
                  devHandlers
                )}
              </>
            )}

            <button
              className="settings__menu-button"
              onClick={() => setIsOpen(false)}
            >
              close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default SettingsMenu;
