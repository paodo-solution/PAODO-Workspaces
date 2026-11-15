import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Opening a workspace secret needs the private key, which only credproxy and vault-init mount. Keeping these
// modules out of every app import graph keeps the Next.js bundle unable to open one.
const SECRET_OPENING_BAN = {
  group: [
    "**/secretOpen",
    "**/workspaceSecretRules",
    "**/workspaceSecretKeyPaths",
    "**/legacyVaultV1",
    "**/workspaceSecretVaultInit",
  ],
  message: "Only credproxy and vault-init may open workspace secrets or touch their private key.",
};

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
    // Listed before the rootedFs block, which restates this ban since a later block replaces the whole rule.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "**/*.test.ts",
      "proxyEntry.ts",
      "vaultInitEntry.ts",
      "lib/infra/proxy/workspaceSecretRules.ts",
      "lib/infra/security/workspaceSecretVaultInit.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [SECRET_OPENING_BAN] }],
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
      "lib/uploads/sweeper.ts",
      "lib/agent/driveAccess.ts",
      "lib/agent/tools/drive*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: ["fs", "fs/promises", "node:fs", "node:fs/promises"].map((name) => ({
            name,
            message: "Use lib/files/rootedFs.ts: a path opened by name here can be redirected by a symlink.",
            allowTypeImports: true,
          })),
          patterns: [SECRET_OPENING_BAN],
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
