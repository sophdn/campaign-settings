import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  {
    files: ['packages/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    // Non-type-aware lint for speed; flip on projectService when type-aware rules are wanted.
    languageOptions: { parserOptions: { projectService: false } },
  },
)
