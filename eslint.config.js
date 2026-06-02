import globals from "globals";
import pluginJs from "@eslint/js";
import pluginReact from "eslint-plugin-react";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginUnusedImports from "eslint-plugin-unused-imports";

export default [
  {
    files: [
      "src/components/**/*.{js,mjs,cjs,jsx}",
      "src/pages/**/*.{js,mjs,cjs,jsx}",
      "src/Layout.jsx",
    ],
    ignores: ["src/lib/**/*", "src/components/ui/**/*"],
    ...pluginJs.configs.recommended,
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    plugins: {
      react: pluginReact,
      "react-hooks": pluginReactHooks,
      "unused-imports": pluginUnusedImports,
    },
    rules: {
      // no-undef catches references to identifiers that were never
      // declared OR imported in scope. Explicitly enabled because the
      // surrounding `rules: {}` object REPLACES (not merges with) the
      // rules from pluginJs.configs.recommended above — so no-undef
      // from `recommended` was being silently dropped, and CI's lint
      // step was passing on broken JS.
      //
      // This rule is the primary defence against the merge-loss class
      // of bug that ate Settings → Maintenance + Hub Backups (PR #253):
      // a useState block gets dropped during a merge while the JSX
      // that references its identifiers stays intact, and the
      // resulting ReferenceError only surfaces at runtime when the
      // operator opens the affected page. With no-undef as an error,
      // CI now catches this at PR-open time.
      //
      // Enabling this rule on the existing codebase also caught one
      // pre-existing latent bug — see the matching change to
      // src/pages/Reconciliation.jsx in this commit.
      "no-undef": "error",
      "no-unused-vars": "off",
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper", "toast-close"] },
      ],
      "react-hooks/rules-of-hooks": "error",
      // Blocks `try { ... } catch {}` and `try { ... } catch (_) {}` from
      // shipping. Every caught error must surface to log or toast — operator
      // guidance from 2026-05-28 after a silent-failure audit found ~50
      // swallowed errors that hid real bugs. If a catch is intentionally
      // doing nothing (e.g. discarding a localStorage write quota error),
      // tag it with `// eslint-disable-line no-empty` and a one-line reason.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  // Server-side, libs, scripts — the same no-empty guard but no React/JSX
  // rules. Without this block, server files like src/routes/*.js and
  // src/services/*.js were entirely unlinted and accumulated the silent
  // catches that the 2026-05-28 audit had to clean up.
  {
    files: [
      "src/routes/**/*.js",
      "src/services/**/*.js",
      "src/db/**/*.js",
      "src/lib/**/*.js",
      "src/hubPostgres/**/*.js",
      "src/api/**/*.js",
      "src/helpers.js",
      "src/startup.js",
      "src/scheduler.js",
      "src/fieldRegistry.js",
      "server.js",
      "scripts/**/*.{js,mjs}",
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
];
