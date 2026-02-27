"use client";

import TouchControls from "./TouchControls/TouchControls";
import KeyboardControls from "./KeyboardControls/KeyboardControls";
import "./Navigation.scss";
import { useEffect, useState } from "react";

const Navigation = () => {
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() =>
    setIsTouchDevice(window.matchMedia("(pointer: coarse)").matches)
  );

  return isTouchDevice ? <TouchControls /> : <KeyboardControls />;
};

export default Navigation;
