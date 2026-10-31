import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', args: 'after-used', caughtErrors: 'none' }],
    },
  },
  // The bins' Node-version guard must run on Node 18 and later, so the bins themselves stay ES2022.
  { files: ['bin/**'], languageOptions: { ecmaVersion: 2022 } },
];
