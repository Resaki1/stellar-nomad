"use client";

import { Provider } from "jotai";

export default function Providers({ children }: any) {
  return <Provider>{children}</Provider>;
}
