import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees/` holds full checkouts of this repo (agent worktrees).
  // Without this, every tool scanning the tree double-counts the whole codebase.
  globalIgnores(['dist', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  // Supabase Edge Functions run on Deno, not in the browser, and deploy through
  // Supabase rather than this build — tsconfig.app.json only includes `src`, so
  // tsc never sees them. Their `@ts-nocheck` is deliberate: the repo's TS setup
  // can't resolve Deno globals or `npm:`/URL import specifiers.
  {
    files: ['supabase/functions/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, Deno: 'readonly' },
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
])
