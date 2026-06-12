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
  globalIgnores([
    ".next/**",
    ".claude/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/basis/**",
  ]),
]);
