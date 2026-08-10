import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".trae/**",
      "**/dist/**",
      "**/.vitepress/cache/**",
      "**/node_modules/**",
      "apps/docs/public/source/**",
      "playwright-report/**",
      "test-results/**",
      "test_assets/**",
      "packages/media-wasm/pkg/**",
      "packages/media-wasm/pkg-node/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/editor/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
);
