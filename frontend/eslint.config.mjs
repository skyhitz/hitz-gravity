import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Worker gateway runs on the Cloudflare Workers runtime with its
    // own tsconfig (functions/tsconfig.json). It's not part of the Next
    // build, so keep it out of the Next lint pass too.
    "functions/**",
  ]),
]);

export default eslintConfig;
