import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import tsParser from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['.eslintrc.js', 'src/api-serverless/src/generated/*']
  },

  ...tseslint.config(eslint.configs.recommended, tseslint.configs.recommended),

  {
    files: ['**/*.ts', '**/*.tsx'],

    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module'
      },
      ecmaVersion: 'latest',

      globals: {
        ...globals.node,
        ...globals.jest
      }
    },

    plugins: { prettier: prettierPlugin },

    rules: {
      'no-console': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'prefer-spread': 'warn',
      'no-prototype-builtins': 'off',
      'prettier/prettier': 'error'
    }
  }
];