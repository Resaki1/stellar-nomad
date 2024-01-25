import { atom } from "jotai";

export type SetAtom<Args extends any[], Result> = (...args: Args) => Result;

export type Settings = {
  graphics: {
    bloom: boolean;
  };
};

export const settingsAtom = atom<Settings>({
  graphics: {
    bloom: false,
  },
});

export const bloomAtom = atom(false);
export const toneMappingAtom = atom(false);
