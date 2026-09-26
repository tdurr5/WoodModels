Vendored from the `three` npm package, version 0.160.0 (MIT, see LICENSE), so
the viewer works offline in the shop:

- `three.module.min.js` - `build/three.module.min.js`
- `addons/controls/OrbitControls.js`, `addons/loaders/OBJLoader.js`,
  `addons/loaders/MTLLoader.js` - unmodified from `examples/jsm/`

To update, bump `three` in package.json, `npm install`, and copy the same files.
