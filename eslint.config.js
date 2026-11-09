import eslint from '@eslint/js';
import babelParser from '@babel/eslint-parser';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [
            ['@babel/plugin-syntax-typescript', { allExtensions: true, isTSX: true }],
            '@babel/plugin-syntax-jsx',
          ],
        },
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
