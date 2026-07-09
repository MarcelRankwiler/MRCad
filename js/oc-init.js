// Boots the OpenCascade WASM kernel and wires it up to replicad's high-level
// API (draw/extrude/fuse/cut/mesh) - this is the BREP replacement for the
// old vendored js/csg.js. Both vendor files are ES modules with zero bare
// imports (checked before vendoring), so they can be loaded directly via a
// relative <script type="module"> without any bundler/build step.
//
// app.js is a classic (non-module) script and can't use import/export, so we
// expose what it needs on `window`: `window.replicad` (the whole module) and
// `window.ocReadyPromise` (resolves once the WASM kernel is initialized and
// replicad.setOC() has been called - app.js awaits this before its first
// extrude/export).
import initOpenCascade from '../vendor/replicad_single.js';
import * as replicad from '../vendor/replicad.js';

window.replicad = replicad;

const overlay = document.getElementById('oc-loading-overlay');
const detailEl = document.getElementById('oc-loading-detail');

// locateFile's returned path is fetched relative to the *document*, not this
// module - so a plain '../vendor/' string breaks the moment index.html isn't
// at a fixed depth from this file. Resolve it against this module's own URL
// (import.meta.url) instead, so it's correct regardless of how deep the page
// that includes it lives.
const vendorBase = new URL('../vendor/', import.meta.url);

window.ocReadyPromise = initOpenCascade({
  locateFile: (path) => new URL(path, vendorBase).href,
}).then((oc) => {
  replicad.setOC(oc);
  if (overlay) overlay.style.display = 'none';
  return true;
}).catch((err) => {
  console.error('OpenCascade-Initialisierung fehlgeschlagen:', err);
  if (detailEl) {
    detailEl.textContent = 'Fehler beim Laden des BREP-Kernels: ' + (err && err.message ? err.message : err) +
      ' - läuft diese Seite über http://(z.B. serve.ps1), nicht per Doppelklick als file://?';
  }
  throw err;
});
