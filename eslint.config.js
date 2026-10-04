// ESLint (flat config). `npm run lint` — CI fails on errors; warnings are listed but allowed.
// Type information is not used (fast); `npm run typecheck` covers types.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig(
  { ignores: ['dist/**', 'public/**', 'node_modules/**', 'supabase/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Hooks called conditionally or outside components break React state: always an error.
      'react-hooks/rules-of-hooks': 'error',
      // Missing effect dependencies cause stale data; intentional omissions carry a disable comment.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['api/**/*.ts', 'scripts/**/*.{js,mjs}', 'tests/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // Interop with untyped SDK payloads (APS, xeokit, PostgREST rows) uses `any` on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `cond ? set.add(x) : set.delete(x)` toggles are an accepted idiom here.
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true, allowShortCircuit: true }],
    },
  },
);
