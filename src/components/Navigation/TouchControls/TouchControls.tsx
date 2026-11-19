import { useEffect, useRef, type PointerEvent } from "react";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronUp, Octagon } from "lucide-react";
import { settingsAtom } from "@/store/store";
import { playerInput, pressFlightAction, releaseHeldActions } from "@/input/playerInput";
import { isCursorNeeded, onSteeringRelease } from "@/input/pointerLock";
import { getAppPhase } from "@/components/AppShell/appState";
import "./TouchControls.scss";

type EngineAction = "accelerate" | "decelerate" | "brake";
const canFly = () => !isCursorNeeded() && getAppPhase() === "playing";

export default function TouchControls() {
  const { invertPitch } = useAtomValue(settingsAtom);
  const stick = useRef<HTMLDivElement>(null);
  const steering = useRef<number | null>(null);
  const engines = useRef(new Map<EngineAction, number>());
  useEffect(() => { playerInput.invertPitch = invertPitch; }, [invertPitch]);

  function center() {
    steering.current = null;
    playerInput.stickPitch = playerInput.stickYaw = 0;
    stick.current?.style.removeProperty("transform");
  }
  useEffect(() => {
    const active = engines.current;
    const release = () => {
      center();
      active.clear();
      releaseHeldActions();
    };
    const visibility = () => { if (document.hidden) release(); };
    const unsubscribe = onSteeringRelease(release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      unsubscribe();
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
      release();
    };
  }, []);

  function steer(e: PointerEvent<HTMLDivElement>) {
    if (steering.current !== e.pointerId) return;
    const r = e.currentTarget.getBoundingClientRect();
    const radius = r.width * 0.32;
    const x = (e.clientX - r.left - r.width / 2) / radius;
    const y = (e.clientY - r.top - r.height / 2) / radius;
    const scale = Math.max(1, Math.hypot(x, y));
    playerInput.stickYaw = x / scale;
    playerInput.stickPitch = -y / scale;
    if (stick.current) stick.current.style.transform = `translate(${x / scale * radius}px,${y / scale * radius}px)`;
  }

  function engine(action: EngineAction, label: string, icon: React.ReactNode) {
    const stop = (e: PointerEvent) => {
      if (engines.current.get(action) !== e.pointerId) return;
      engines.current.delete(action);
      playerInput.held[action] = false;
    };
    return <button type="button" aria-label={label} onPointerDown={e => {
      if (!canFly() || engines.current.has(action)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      engines.current.set(action, e.pointerId);
      playerInput.held[action] = true;
      pressFlightAction(action);
    }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>{icon}<span>{label}</span></button>;
  }

  return <div className="touch-flight">
    <div className="touch-flight__stick" aria-label="Pitch and yaw" onPointerDown={e => {
      if (!canFly() || steering.current !== null) return;
      steering.current = e.pointerId;
      e.currentTarget.setPointerCapture(e.pointerId);
      steer(e);
    }} onPointerMove={steer} onLostPointerCapture={e => { if (steering.current === e.pointerId) center(); }}>
      <div className="touch-flight__thumb" ref={stick} />
    </div>
    <div className="touch-flight__engine">
      {engine("accelerate", "Thrust", <ChevronUp size={19} />)}
      {engine("decelerate", "Ease off", <ChevronDown size={19} />)}
      {engine("brake", "Brake", <Octagon size={15} />)}
    </div>
  </div>;
}
