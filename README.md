# WoodModels

A 3D cut-list/hardware-list viewer for woodworking plans, built starting from the Lie-Nielsen/Brian Boggs shaving horse plan.

Parses a COLLADA (`.dae`) export from SketchUp, extracts every named component's real dimensions and orientation (fitting an oriented bounding box per part, not just a naive axis-aligned one - important for parts that are pre-rotated in their own local geometry, like splayed legs), and renders it all in a browser-based viewer with an interactive cut list.

## What's here

- `parse_dae.py` - reads a SketchUp COLLADA export and produces the viewer's data files: `scene.obj`/`scene.mtl` (geometry), `parts_report.json` (cut list with dimensions, quantities, materials), `object_dims.json` (per-part oriented dimension + compound-angle data), `materials.json` (material name mapping).
- `viewer/` - the browser app (three.js). Open `index.html` via a local web server (not `file://`, since it fetches JSON).
- `renders/` - static preview renders (Blender).
- `shavehorse.blend` - Blender scene with the model already imported, for opening in real 3D software with its own Outliner/click-to-select.

## Running the viewer

```
cd viewer
python3 -m http.server 8743
```

Then open `http://localhost:8743` in a browser.

### Viewer features

- Click a part in the sidebar cut list, or click it directly on the 3D model, to isolate/highlight it.
- Cut list is split into Wood / Hardware / Leather sections.
- Selecting a part shows its real length/width/thickness as dimension lines drawn directly on the part (oriented to the part's true axes, not just world axes), plus the compound lean angle (with a visual protractor wedge) for parts like splayed legs that aren't cut square.
- **Measure distance** / **Measure angle** tools: select a part first, then click points directly on that part (snapped to the nearest real vertex) to measure exact distances or angles between specific points - useful when a part's shape is too irregular for the automatic per-part dimensions to make sense of.

## Regenerating the data

`parse_dae.py` expects the source `.dae` (and its texture folder) at a hardcoded path near the top of the file - update `DAE` and `OUT_DIR` there if regenerating from a different source model or output location. Requires only the Python standard library (no pip packages).

```
python3 parse_dae.py
```

## Known data caveats

The source SketchUp file has a couple of quirks that `parse_dae.py` works around (documented inline in the script):
- One hardware component's geometry was corrupted (huge bogus bounding box) - it's excluded from the 3D view, and its quantity is inferred from the matching rod count instead.
- Two hardware parts are modeled as several small face-facets per real fastener rather than one part per instance - quantities are corrected to the real fastener count.
- Some parts' local mesh geometry is pre-rotated in the source file rather than transformed via the scene graph - `parse_dae.py` detects this by comparing a simple axis-aligned bounding box against a PCA-fitted oriented one and uses whichever is tighter.
