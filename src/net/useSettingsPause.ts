import { useAtomValue } from "jotai";
import { useSyncExternalStore } from "react";
import { settingsIsOpenAtom } from "@/store/store";
import { coopSnapshot, subscribeCoop } from "./coopState";

function pauseMode(): "solo" | "host" | "shared" {
  const { role, status, players } = coopSnapshot();
  // A guest always shares with the host. The invite's slot count predates admission.
  if (role === "guest" || players > 1) return "shared";
  return role === "host" && status !== "starting" ? "host" : "solo";
}

/** An open room still pauses while its host is the only pilot. */
export function useSettingsPause(): "running" | "solo" | "host" {
  const open = useAtomValue(settingsIsOpenAtom);
  const mode = useSyncExternalStore(subscribeCoop, pauseMode, pauseMode);
  return open && mode !== "shared" ? mode : "running";
}
