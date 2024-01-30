import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type SetAtom<Args extends any[], Result> = (...args: Args) => Result;

export type Movement = {
  yaw: number;
  pitch: number;
  speed: number;
};

export type Settings = {
  invertPitch: boolean;
  bloom: boolean;
  toneMapping: boolean;
  fps: boolean;
  initial: boolean;
};

export const settingsAtom = atomWithStorage<Settings>("settings", {
  invertPitch: false,
  bloom: false,
  toneMapping: false,
  fps: false,
  initial: true,
});

export const settingsIsOpenAtom = atom(false);

export const movementAtom = atom<Movement>({
  yaw: 0,
  pitch: 0,
  speed: 1,
});

export const hudInfoAtom = atom({
  speed: 0,
});
