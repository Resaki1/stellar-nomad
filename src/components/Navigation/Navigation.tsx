"use client";

import { useAtomValue } from "jotai";
import { hudHiddenAtom } from "@/store/store";
import TouchControls from "./TouchControls/TouchControls";
import KeyboardControls from "./KeyboardControls/KeyboardControls";
import MouseControls from "./MouseControls";
import "./Navigation.scss";
import { useEffect, useState } from "react";

const Navigation = () => {
  const hudHidden = useAtomValue(hudHiddenAtom);
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    setIsTouchDevice(window.matchMedia("(pointer: coarse)").matches);
  }, []);

  if (isTouchDevice) return hudHidden ? null : <TouchControls />;
  return (
    <>
      <KeyboardControls />
      <MouseControls />
    </>
  );
};

export default Navigation;
