import { settingsIsOpenAtom } from "@/store/store";
import { useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { useEffect } from "react";

const Anchor = () => {
  const settingsIsOpen = useAtomValue(settingsIsOpenAtom);

  const set = useThree((state) => state.set);
  useEffect(() => {
    set({ frameloop: settingsIsOpen ? "never" : "always" });
  }, [settingsIsOpen]);

  return <></>;
};

export default Anchor;
