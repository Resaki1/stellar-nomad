import { atomWithStorage } from "jotai/utils";

export type SetAtom<Args extends any[], Result> = (...args: Args) => Result;

export type Settings = {
  invertPitch: boolean;
  bloom: boolean;
  toneMapping: boolean;
};

export const settingsAtom = atomWithStorage<Settings>("settings", {
  invertPitch: false,
  bloom: false,
  toneMapping: false,
});
