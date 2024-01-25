import { atom } from "jotai";

export type SetAtom<Args extends any[], Result> = (...args: Args) => Result;

export type Settings = {
  invertPitch: boolean;
  bloom: boolean;
  toneMapping: boolean;
};

export const settingsAtom = atom<Settings>({
  invertPitch: false,
  bloom: false,
  toneMapping: false,
});
