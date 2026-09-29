// Catches undefined names and similar slips in the no-build-step viewer code.
export default [{ ignores: ['viewer/vendor/**'] }, {
  files: ['**/*.js', '**/*.mjs'],
  languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: {
    window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly', localStorage: 'readonly',
    performance: 'readonly', requestAnimationFrame: 'readonly', ResizeObserver: 'readonly', MouseEvent: 'readonly', Event: 'readonly',
    CSS: 'readonly', Blob: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly', structuredClone: 'readonly',
    fetch: 'readonly', navigator: 'readonly', getComputedStyle: 'readonly', DOMParser: 'readonly', TextEncoder: 'readonly', indexedDB: 'readonly', DecompressionStream: 'readonly', CompressionStream: 'readonly', Response: 'readonly', TextDecoder: 'readonly', File: 'readonly', crypto: 'readonly', self: 'readonly', caches: 'readonly', process: 'readonly', Buffer: 'readonly',
    IDBKeyRange: 'readonly', createImageBitmap: 'readonly', PointerEvent: 'readonly' } },
  rules: { 'no-unused-vars': 'warn', 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-redeclare': 'error', 'no-const-assign': 'error', 'no-self-assign': 'warn', 'eqeqeq': ['warn', 'smart'] },
}];
