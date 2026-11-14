import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Underscore-prefixed parameters are intentionally unused adapters or callback fields.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // Vitest fixtures use require() inside vi.hoisted(), which runs before ESM imports.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    rules: {
      // .cjs is CommonJS by extension, so require() is the only way to import in these scripts.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // These reach agent-writable trees only through lib/files/rootedFs.ts, which never follows a link.
    files: [
      "lib/operations/files/content.ts",
      "lib/operations/files/listing.ts",
      "lib/files/tree.ts",
      "lib/files/entries.ts",
      "lib/files/zip.ts",
      "lib/files/move.ts",
      "lib/uploads/upload.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: ["fs", "fs/promises", "node:fs", "node:fs/promises"].map((name) => ({
            name,
            message: "Use lib/files/rootedFs.ts: a path opened by name here can be redirected by a symlink.",
            allowTypeImports: true,
          })),
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated output and local-only fixtures from this repository.
    ".data-backup/**",
    "coverage/**",
    "data/**",
    "e2e/**",
    "test-results/**",
    "playwright.config.ts",
  ]),
]);

export default eslintConfig;
