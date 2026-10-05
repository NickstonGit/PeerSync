import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

const NO_RAW_COLORS = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
      message:
        'Color literals are banned. Use a shared design token or named semantic value instead.',
    },
    {
      selector: "Literal[value=/^rgba?\\(/]",
      message:
        'rgb()/rgba() literals are banned. Use a token, or compose alpha with withAlpha(token, alpha) at runtime.',
    },
    {
      selector: "TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}/]",
      message:
        'Color literals (hex) inside template strings are banned. Compose with tokens via interpolation.',
    },
    {
      selector: "TemplateElement[value.raw=/rgba?\\(/]",
      message:
        'rgb()/rgba() inside template strings are banned. Use tokens / withAlpha.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.bundle.js',
      'packages/core/schema/**',
    ],
  },

  ...tseslint.configs.recommended,

  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'unused-imports': unusedImports,
    },
    rules: {
      ...NO_RAW_COLORS,
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  {
    files: ['**/*.d.ts'],
    rules: {
      'unused-imports/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-var': 'off',
    },
  },

  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
