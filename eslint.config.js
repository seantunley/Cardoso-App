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
    },
  },
];
