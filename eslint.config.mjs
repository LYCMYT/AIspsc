import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '.cache/**', '**/test-results/**', '**/playwright-report/**', 'references/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  { files: ['**/*.{js,mjs,ts,vue}'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: ts.parser } }, rules: { 'vue/multi-word-component-names': 'off', 'vue/html-self-closing': ['warn', { html: { void: 'always', normal: 'always', component: 'always' } }] } },
];
