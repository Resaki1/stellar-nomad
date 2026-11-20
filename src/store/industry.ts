import { atom } from "jotai";
import { emptyIndustry, type IndustryState } from "@/sim/industry/types";

export const industryAtom = atom<IndustryState>(emptyIndustry());
