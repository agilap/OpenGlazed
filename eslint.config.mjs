import globals from 'globals';

// Only catches undefined names: the build and tests miss them (a removed setter once shipped this way).
export default [
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  {
    files: ['frontend/**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: globals.browser },
    rules: { 'no-undef': 'error' },
  },
  { files: ['frontend/vite.config.js'], languageOptions: { globals: globals.node } },
  {
    files: ['backend/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-undef': 'error' },
  },
  { files: ['backend/public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
];
