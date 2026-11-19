import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React Compiler lint rules (react-hooks v7) assume compiler-compatible
    // code. This codebase intentionally drives the sim/render loop through
    // ref mutation and ref reads during render (see CLAUDE.md, R3F
    // conventions), so these stay advisory rather than gate-blocking.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  {
    // Sim and save must stay engine-free so the world sim can run headless (M4 host / server).
    files: ["src/sim/**", "src/save/**"],
    // React by design: context providers / R3F loaders. nearbyStars.ts imports a component
    // helper (equatorialToGame) and should move it into src/sim.
    ignores: [
      "src/sim/worldOrigin.tsx",
      "src/sim/asteroids/runtimeContext.tsx",
      "src/sim/asteroids/modelRegistry.ts",
      "src/sim/nearbyStars.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["react", "react/*", "jotai", "jotai/*", "@react-three/*", "@/store/*", "@/components/*"],
              message: "src/sim and src/save must not depend on React, jotai, R3F, stores or components.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "services/coop-signal/.wrangler/**",
    ".claude/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/basis/**",
    // scripts/drive.mjs output, incl. a Chrome profile full of third-party JS
    ".captures/**",
  ]),
]);
