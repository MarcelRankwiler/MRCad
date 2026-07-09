// ---------------------------------------------------------------------------
// Simple CAD - sketch (lines + circles) -> extrude -> STL export
// Shape coordinates are stored in mm ("world space"). The sketch canvas can be
// zoomed/panned (viewScale/viewOffset); screenToWorld/worldToScreen convert
// between CSS-pixel screen space and mm world space.
// ---------------------------------------------------------------------------

// ---- state ----------------------------------------------------------------
let shapes = [];          // {id, type:'polygon'|'circle', points:[{x,y}]|null, center, radius, closed, isHole, isAdditive, additiveHeight, additiveSide:'top'|'bottom', holeDepth}
                           // every shape is either isAdditive (grows from the sketch plane Z=0 by its own additiveHeight, toward +Z ('top') or -Z ('bottom'))
                           // or isHole (cuts from Z=0 by its own holeDepth, same 'top'/'bottom' meaning via additiveSide) - see buildBaseGroup()
                           // text-tool pieces are plain `polygon` shapes too (kind:'text', char - see textToShapePieces)
                           // multi-piece placements (text, hole-circle patterns) share a `groupId` so they select/drag/edit together
                           // polygon shapes may also have filletRadii: {vertexIndex: radiusMm} - rounded corners, see getFilletedPoints()
let nextShapeId = 1;
let currentTool = 'line';
let drawingPoints = [];   // in-progress polygon points
let circleCenter = null;  // in-progress circle center
let shapeStartPoint = null; // in-progress rect/regular-polygon tool: first click (corner or center)
let mousePos = null;      // current mouse position (canvas space), for previews
let selectedShapeIds = new Set(); // Ctrl/Cmd-click adds/removes a shape in the 'select' tool, for multi-drag/multi-edit
let extrudedGroup = null; // THREE.Group currently in the viewer, exportable
let dimEditor = null;     // active length/radius <input> overlay, if any
let pointEditor = null;   // active point-mode X/Y <input> overlay, if any
let filletEditor = null;  // active corner-radius <input> overlay, if any (see filletCornerArc)
let history = [];         // stack of previous `shapes` snapshots, for undo
let dragState = null;     // active shape-drag: {shapeId, original, startRaw, dx, dy, moved}
let viewScale = 1;        // world mm -> screen CSS px zoom factor
let viewOffset = { x: 0, y: 0 }; // screen px position of world origin (0,0)
let panState = null;      // active view pan (middle-mouse drag): {startX, startY, startOffset}
let refLineAngle = null;  // world-space angle (rad) of an Alt-selected reference line, while drawing
let refLineSeg = null;    // {a,b} endpoints of the reference line, for highlighting
let angleLockActive = false; // true while Ctrl is held during line drawing, fixing the current segment's angle
let angleLockAngle = null;   // the fixed world-space angle (rad), captured at the moment Ctrl was pressed
let angleLockSnapHit = null; // world point the locked-angle length last snapped onto (for a highlight dot), or null

// ---- face-editing state -----------------------------------------------------
// faceFeatures: ordered list of applied face-sketch features (boss/pocket geometry
// sketched on a picked planar face of the extruded solid), each:
// {id, basis:{origin,normal,uAxis,vAxis} (THREE.Vector3, "centered model space"),
//  boundaryLoopUV:[{x,y}], innerLoopsUV:[[{x,y}]], shapes:[...]}
let faceFeatures = [];
let nextFeatureId = 1;
let faceSelectMode = false;  // waiting for a click on the 3D model to pick a face
// while sketching a face feature: {featureId|null (null = new), basis, boundaryLoopUV,
// innerLoopsUV, baseShapes, baseHistory} - baseShapes/baseHistory are the stashed base
// sketch's `shapes`/`history`, restored on exit
let faceEditContext = null;
let baseRollback = false; // true while the history tree is temporarily rolled back to the base sketch (extrudedGroup cleared, "Extrudieren" pending)
let meshVersion = 0;         // bumped whenever extrudedGroup is rebuilt; invalidates faceAdjacencyCache
let faceAdjacencyCache = null; // {version, byObject: Map(mesh -> adjacency)}
let hoverFaceHighlight = null;    // THREE.Mesh overlay for the currently hovered pickable face
let selectedFaceHighlight = null; // THREE.Mesh overlay for the face currently being sketched on

const CLOSE_SNAP_PX = 10;
const SEGMENT_HIT_PX = 8;
const POINT_HIT_PX = 8;
const LENGTH_SNAP_PX = 10;
const HISTORY_LIMIT = 100;
const MIN_SCALE = 0.2;
const MAX_SCALE = 40;

// True whenever the in-memory project (shapes, extrude depth, face features)
// differs from the last saved/loaded .mrcad file - drives the "unsaved
// changes" prompts on page unload and on "Skizze leeren".
let projectDirty = false;

function markProjectDirty() {
  projectDirty = true;
}

function pushHistory() {
  history.push(JSON.parse(JSON.stringify(shapes)));
  if (history.length > HISTORY_LIMIT) history.shift();
  markProjectDirty();
}

// ---- DOM refs ---------------------------------------------------------------
const canvas = document.getElementById('sketch-canvas');
const ctx = canvas.getContext('2d');
const gridSizeInput = document.getElementById('grid-size');
const gridOnInput = document.getElementById('grid-on');
const angleStepInput = document.getElementById('angle-step');
const angleOnInput = document.getElementById('angle-on');
const rasterDistanceInput = document.getElementById('raster-distance-on');
const shapeListEl = document.getElementById('shape-list');
const extrudeStatusEl = document.getElementById('extrude-status');
const btnExtrude = document.getElementById('btn-extrude');
const btnExport = document.getElementById('btn-export');
const btnUndo = document.getElementById('btn-undo');
const btnClear = document.getElementById('btn-clear');
const btnSaveProject = document.getElementById('btn-save-project');
const btnLoadProject = document.getElementById('btn-load-project');
const loadProjectInput = document.getElementById('load-project-input');

// BREP kernel (OpenCascade via replicad, see js/oc-init.js) loads
// asynchronously - keep "Extrudieren" disabled with a status message until
// it's ready, instead of letting the first click silently fail inside
// buildBaseGroup()/replicad's getOC().
btnExtrude.disabled = true;
extrudeStatusEl.textContent = 'BREP-Kernel wird geladen…';
window.ocReadyPromise.then(() => {
  btnExtrude.disabled = false;
  extrudeStatusEl.textContent = '';
}).catch(() => {
  extrudeStatusEl.textContent = 'BREP-Kernel konnte nicht geladen werden (siehe Konsole).';
});

// ===========================================================================
// Canvas / sketch setup
// ===========================================================================

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const hintH = document.getElementById('sketch-hint').offsetHeight;
  const titleH = canvas.parentElement.querySelector('.pane-title').offsetHeight;
  const w = rect.width;
  const h = rect.height - hintH - titleH;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, w * dpr);
  canvas.height = Math.max(1, h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function getGridSize() {
  return Math.max(1, parseFloat(gridSizeInput.value) || 10);
}

// Snap increment to use for point placement / dragging: the configured grid size
// when the snap grid is on, otherwise a fine 0.1 mm step instead of raw mouse pixels.
function getSnapSize() {
  return gridOnInput.checked ? getGridSize() : 0.1;
}

function snapValue(v, g) {
  return Math.round(Math.round(v / g) * g * 10000) / 10000;
}

function snap(pt) {
  const g = getSnapSize();
  return { x: snapValue(pt.x, g), y: snapValue(pt.y, g) };
}

function screenToWorld(sx, sy) {
  return { x: (sx - viewOffset.x) / viewScale, y: (sy - viewOffset.y) / viewScale };
}

function worldToScreen(wx, wy) {
  return { x: wx * viewScale + viewOffset.x, y: wy * viewScale + viewOffset.y };
}

function getMousePos(evt) {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Returns true for the fixed-vertex-count shape tools (rectangle, regular
// N-gon), which all share the same "click start point, click again to set
// size" interaction and produce a plain `polygon` shape under the hood.
function isShapeTool(tool) {
  return tool === 'rect' || tool.startsWith('poly');
}

// Axis-aligned rectangle corners from two opposite corner points.
function rectPoints(a, b) {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

// Vertices of a regular polygon with the given circumradius, centered on
// `center`, with its first vertex at `angleOffset` (radians).
function regularPolygonPoints(center, radius, sides, angleOffset) {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const a = angleOffset + (i * 2 * Math.PI) / sides;
    points.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return points;
}

// Reads the current Lochkreis-panel settings and returns the hole centers
// (world space) for a bolt-circle pattern around `center` - evenly spaced,
// starting straight up (common bolt-pattern convention).
function holeCirclePieces(center) {
  const radius = Math.max(0, parseFloat(document.getElementById('holecircle-radius').value) || 0);
  const count = Math.max(1, Math.round(parseFloat(document.getElementById('holecircle-count').value) || 1));
  const centers = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    centers.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return centers;
}

// Computes the preview/final point list for the shape currently being placed
// with a rect/poly tool, given its start point and the (already snapped)
// second point.
function shapeToolPoints(tool, start, p) {
  if (tool === 'rect') return rectPoints(start, p);
  const sides = parseInt(tool.slice(4), 10);
  const r = dist(start, p);
  const angle = Math.atan2(p.y - start.y, p.x - start.x);
  return regularPolygonPoints(start, r, sides, angle);
}

// ===========================================================================
// Text tool: converts a typed string into plain `polygon` shapes (one or more
// per character), using opentype.js to read real vector glyph outlines from
// a handful of bundled font files. Each resulting shape is just an ordinary
// polygon - counters (the hole in "O", "A", "8", ...) are baked directly into
// the outer contour via a zero-width bridge/slit ("keyhole" technique) rather
// than being separate isHole shapes, so every existing mechanism (fill,
// selection, dragging, additive/hole extrude, face features, save/load)
// handles text with no further changes.
// ===========================================================================

const TEXT_FONTS = [
  { key: 'sans', label: 'Serifenlos – PT Sans' },
  { key: 'sans-bold', label: 'Serifenlos Fett – PT Sans Bold' },
  { key: 'serif', label: 'Serif – PT Serif' },
  { key: 'serif-bold', label: 'Serif Fett – PT Serif Bold' },
  { key: 'mono', label: 'Monospace – Courier Prime' },
  { key: 'mono-bold', label: 'Monospace Fett – Courier Prime Bold' },
  { key: 'script', label: 'Schreibschrift – Pacifico' },
  { key: 'handwriting', label: 'Handschrift – Indie Flower' },
  { key: 'display', label: 'Plakat Fett – Anton' },
  { key: 'condensed', label: 'Plakat Schmal – Bebas Neue' },
  { key: 'pixel', label: 'Retro-Pixel – VT323' },
];
const loadedTextFonts = {}; // key -> parsed opentype.js Font, once loaded
let textFontsReady = false;
let textMode = 'extrude'; // 'extrude' (raised/solid) | 'cut' (engraved/subtracted)
let textSide = 'top';     // additiveSide for base-sketch raised text ('top'|'bottom')

// Decodes a base64 string (from js/embedded-fonts.js) into an ArrayBuffer.
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function initTextTool() {
  const select = document.getElementById('text-font');
  TEXT_FONTS.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.key;
    opt.textContent = f.label;
    select.appendChild(opt);
  });
  const statusEl = document.getElementById('text-font-status');
  // Fonts are embedded as base64 (js/embedded-fonts.js) and parsed synchronously
  // via opentype.parse() rather than opentype.load() (which fetches over
  // XMLHttpRequest) - that way the Text tool also works when this page is
  // opened directly by double-clicking index.html (file:// URL), where
  // browsers block XMLHttpRequest/fetch of local files.
  const fontData = window.EMBEDDED_FONTS || {};
  TEXT_FONTS.forEach(f => {
    const b64 = fontData[f.key];
    if (!b64) { console.error('Keine eingebetteten Schriftdaten für:', f.key); return; }
    try {
      loadedTextFonts[f.key] = opentype.parse(base64ToArrayBuffer(b64));
    } catch (e) {
      console.error('Konnte Schriftart nicht parsen:', f.key, e);
    }
  });
  textFontsReady = Object.keys(loadedTextFonts).length > 0;
  statusEl.textContent = textFontsReady ? '' :
    'Schriftarten konnten nicht geladen werden (js/embedded-fonts.js fehlt oder ist beschädigt).';

  const modeExtrudeBtn = document.getElementById('text-mode-extrude');
  const modeCutBtn = document.getElementById('text-mode-cut');
  const heightLabel = document.getElementById('text-height-label');
  const sideRow = document.getElementById('text-side-row');
  const updateModeUI = () => {
    modeExtrudeBtn.classList.toggle('active', textMode === 'extrude');
    modeCutBtn.classList.toggle('active', textMode === 'cut');
    heightLabel.textContent = textMode === 'extrude' ? 'Höhe (mm)' : 'Tiefe (mm)';
    sideRow.style.display = textMode === 'extrude' ? 'flex' : 'none';
    render();
  };
  modeExtrudeBtn.addEventListener('click', () => { textMode = 'extrude'; updateModeUI(); });
  modeCutBtn.addEventListener('click', () => { textMode = 'cut'; updateModeUI(); });

  const sideTopBtn = document.getElementById('text-side-top');
  const sideBottomBtn = document.getElementById('text-side-bottom');
  sideTopBtn.addEventListener('click', () => {
    textSide = 'top';
    sideTopBtn.classList.add('active');
    sideBottomBtn.classList.remove('active');
  });
  sideBottomBtn.addEventListener('click', () => {
    textSide = 'bottom';
    sideBottomBtn.classList.add('active');
    sideTopBtn.classList.remove('active');
  });

  ['text-content', 'text-size', 'text-scalex', 'text-spacing', 'text-font'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
  });

  ['holecircle-radius', 'holecircle-count', 'holecircle-diameter'].forEach(id => {
    document.getElementById(id).addEventListener('input', render);
  });
}

const TEXT_CURVE_STEPS = 8; // bezier flattening resolution for glyph outlines

// Flattens one glyph's outline (opentype.js path commands: M/L/Q/C/Z) into raw
// contours - arrays of {x,y} points in world space, already positioned at
// `penX`/baseline `originY`, scaled to `fontSizeMm`, and horizontally scaled
// by `scaleX` around the glyph's own pen origin (so condensed/expanded text
// stretches each letter's shape, not just the gaps between them).
function flattenGlyphContours(glyph, penX, originY, fontSizeMm, scaleX) {
  const path = glyph.getPath(0, originY, fontSizeMm);
  const contours = [];
  let current = null;
  let cx = 0, cy = 0;
  path.commands.forEach((cmd) => {
    if (cmd.type === 'M') {
      current = [{ x: cmd.x, y: cmd.y }];
      contours.push(current);
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'L') {
      current.push({ x: cmd.x, y: cmd.y });
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'Q') {
      for (let t = 1; t <= TEXT_CURVE_STEPS; t++) {
        const tt = t / TEXT_CURVE_STEPS, mt = 1 - tt;
        current.push({
          x: mt * mt * cx + 2 * mt * tt * cmd.x1 + tt * tt * cmd.x,
          y: mt * mt * cy + 2 * mt * tt * cmd.y1 + tt * tt * cmd.y,
        });
      }
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'C') {
      for (let t = 1; t <= TEXT_CURVE_STEPS; t++) {
        const tt = t / TEXT_CURVE_STEPS, mt = 1 - tt;
        current.push({
          x: mt * mt * mt * cx + 3 * mt * mt * tt * cmd.x1 + 3 * mt * tt * tt * cmd.x2 + tt * tt * tt * cmd.x,
          y: mt * mt * mt * cy + 3 * mt * mt * tt * cmd.y1 + 3 * mt * tt * tt * cmd.y2 + tt * tt * tt * cmd.y,
        });
      }
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'Z' && current && current.length > 1) {
      const first = current[0], last = current[current.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) current.pop();
    }
  });
  contours.forEach(c => c.forEach(p => { p.x = p.x * scaleX + penX; }));
  return contours.filter(c => c.length >= 3);
}

function shoelaceArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Splices a nested contour into its immediate parent via the shortest
// point-to-point bridge (a zero-width "keyhole" slit), producing one
// single closed path that fills identically to the original outer+hole pair
// under any fill rule - this is how a single-contour `polygon` shape can
// still represent a letter with a counter.
function mergeHoleIntoOuter(outer, hole) {
  let bestD = Infinity, bestI = 0, bestJ = 0;
  for (let i = 0; i < outer.length; i++) {
    for (let j = 0; j < hole.length; j++) {
      const d = (outer[i].x - hole[j].x) ** 2 + (outer[i].y - hole[j].y) ** 2;
      if (d < bestD) { bestD = d; bestI = i; bestJ = j; }
    }
  }
  const merged = outer.slice(0, bestI + 1);
  for (let step = 0; step <= hole.length; step++) merged.push(hole[(bestJ + step) % hole.length]);
  merged.push(outer[bestI]);
  for (let k = bestI + 1; k < outer.length; k++) merged.push(outer[k]);
  return merged;
}

// Groups a glyph's raw contours (some of which may be nested counters, or -
// for glyphs like "i", "%", ":" - several unrelated disjoint pieces) into
// one bridged polygon per disjoint top-level piece, by nesting depth via
// point-in-polygon containment (not contour winding direction, which isn't
// reliably consistent across fonts).
function bridgeGlyphContours(contours) {
  const n = contours.length;
  if (n <= 1) return contours.slice();
  const areas = contours.map(c => Math.abs(shoelaceArea(c)));
  const parent = contours.map((c, i) => {
    let bestJ = null, bestArea = Infinity;
    for (let j = 0; j < n; j++) {
      if (j !== i && areas[j] < bestArea && pointInPolygon(contours[i][0], contours[j])) {
        bestArea = areas[j];
        bestJ = j;
      }
    }
    return bestJ;
  });
  const children = contours.map(() => []);
  const roots = [];
  parent.forEach((p, i) => { if (p === null) roots.push(i); else children[p].push(i); });
  function build(i) {
    let poly = contours[i];
    children[i].forEach(childIdx => { poly = mergeHoleIntoOuter(poly, build(childIdx)); });
    return poly;
  }
  return roots.map(build);
}

// Builds the polygon pieces for one line of text, in world space. `originX`/
// `originY` is the baseline start point (left edge) - i.e. exactly where the
// user clicks. Returns [{char, points}], ready to become `shapes` entries.
function textToShapePieces(font, text, originX, originY, fontSizeMm, scaleXPercent, letterSpacingMm) {
  const scaleX = scaleXPercent / 100;
  const advanceScale = fontSizeMm / font.unitsPerEm;
  const pieces = [];
  let penX = originX;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    if (ch !== ' ' && ch !== '\t') {
      const contours = flattenGlyphContours(glyph, penX, originY, fontSizeMm, scaleX);
      bridgeGlyphContours(contours).forEach(points => pieces.push({ char: ch, points }));
    }
    const advance = (glyph.advanceWidth || font.unitsPerEm / 2) * advanceScale;
    penX += advance * scaleX + letterSpacingMm;
  }
  return pieces;
}

// Reads the current Text-panel settings and generates shape pieces at the
// given world point (baseline start). Returns [] if fonts aren't loaded yet,
// no font is selected, or the text field is empty.
function currentTextPieces(originPoint) {
  if (!textFontsReady) return [];
  const font = loadedTextFonts[document.getElementById('text-font').value];
  const text = document.getElementById('text-content').value;
  if (!font || !text) return [];
  const fontSize = Math.max(0.5, parseFloat(document.getElementById('text-size').value) || 15);
  const scaleXPercent = parseFloat(document.getElementById('text-scalex').value) || 100;
  const spacing = parseFloat(document.getElementById('text-spacing').value) || 0;
  return textToShapePieces(font, text, originPoint.x, originPoint.y, fontSize, scaleXPercent, spacing);
}

// Distance along a ray at the given angle from one grid line crossing to the next: for
// axis-aligned angles that's just the grid size, but for a diagonal it's larger since the
// ray covers more ground before its x (or y) coordinate advances by a full grid step - e.g.
// at 45 deg on a 10mm grid it's 10*sqrt(2)mm (the diagonal of one grid cell).
function gridStepAlongAngle(angle, g) {
  const ux = Math.abs(Math.cos(angle));
  const uy = Math.abs(Math.sin(angle));
  const tx = ux > 1e-9 ? g / ux : Infinity;
  const ty = uy > 1e-9 ? g / uy : Infinity;
  return Math.min(tx, ty);
}

// Snaps a segment length for a line drawn at `angle`: normally to plain multiples of the
// grid size, but in "Rasterdistanz-Modus" to multiples of the grid step measured *along that
// angle* instead, so the endpoint lands on the next real grid crossing rather than falling
// short of it on diagonals.
function snapLengthForAngle(rawLength, angle, g) {
  if (rasterDistanceInput.checked) {
    const step = gridStepAlongAngle(angle, g);
    if (isFinite(step)) return Math.round(rawLength / step) * step;
  }
  return snapValue(rawLength, g);
}

// Constrains the segment from `from` to `to` so its angle is a multiple of the
// configured angle step. Length is snapped to the grid (or the 0.1 mm fallback).
function angleSnapPoint(from, to) {
  const stepDeg = Math.max(1, parseFloat(angleStepInput.value) || 45);
  const stepRad = stepDeg * Math.PI / 180;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let angle = Math.round(Math.atan2(dy, dx) / stepRad) * stepRad;
  const length = snapLengthForAngle(Math.hypot(dx, dy), angle, getSnapSize());
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

// Constrains the segment from `from` to `to` to lie exactly on `refAngle` (or its
// opposite direction, whichever is closer to the raw mouse direction). Used to align
// a new segment with an Alt-selected reference line. Length is grid-snapped.
function refAnglePoint(from, to, refAngle) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const rawAngle = Math.atan2(dy, dx);
  const diff = Math.atan2(Math.sin(rawAngle - refAngle), Math.cos(rawAngle - refAngle));
  const angle = Math.abs(diff) > Math.PI / 2 ? refAngle + Math.PI : refAngle;
  const length = snapLengthForAngle(Math.hypot(dx, dy), angle, getSnapSize());
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

// Returns how far along the ray from `from` in direction `dir` (unit vector) the given
// point lies, or null if the point isn't close enough to the ray to count as "on" it.
function projectOntoRay(from, dir, point) {
  const vx = point.x - from.x;
  const vy = point.y - from.y;
  const proj = vx * dir.x + vy * dir.y;
  if (proj <= 0) return null;
  const perp = Math.abs(vx * dir.y - vy * dir.x);
  return perp <= SEGMENT_HIT_PX / viewScale ? proj : null;
}

// Returns the distance along the ray from `from` in direction `dir` (unit vector) at
// which it crosses the finite segment a-b, or null if they don't cross in front of `from`.
function raySegmentIntersection(from, dir, a, b) {
  const dx2 = b.x - a.x, dy2 = b.y - a.y;
  const denom = dx2 * dir.y - dy2 * dir.x;
  if (Math.abs(denom) < 1e-9) return null; // parallel (or the ray's own direction)
  const ex = a.x - from.x, ey = a.y - from.y;
  const t = (dx2 * ey - dy2 * ex) / denom;
  const u = (dir.x * ey - dir.y * ex) / denom;
  return (t > 0 && u >= 0 && u <= 1) ? t : null;
}

// Constrains the segment from `from` to `to` to lie exactly on `angle` (or its opposite
// direction, whichever the mouse is on the side of) - used while Ctrl is held to lock the
// angle. The length follows only the mouse's movement *along that fixed axis* (its
// projection onto the axis) - any sideways drift while maneuvering the cursor towards a
// reference elsewhere on screen is ignored, rather than inflating the length the way the
// raw cursor distance would. It also snaps onto vertices/edges of other shapes (and the
// polyline being drawn) that lie along that fixed direction, so the new segment's endpoint
// can be matched exactly to existing geometry. Falls back to a plain grid-snapped length
// when nothing nearby lies on the ray. Also updates `angleLockSnapHit` for the caller to
// draw a highlight at the snapped-to point.
function angleLockPoint(from, to, angle) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  const proj = dx * ux + dy * uy; // signed distance along the locked axis
  const sign = proj < 0 ? -1 : 1;
  const dir = { x: ux * sign, y: uy * sign };
  const rawLength = Math.abs(proj);

  const catchDist = LENGTH_SNAP_PX / viewScale;
  let bestLength = null;
  let bestDiff = catchDist;
  const consider = (length) => {
    if (length === null) return;
    const d = Math.abs(length - rawLength);
    if (d < bestDiff) { bestDiff = d; bestLength = length; }
  };

  shapes.forEach(s => {
    if (s.type !== 'polygon') return;
    s.points.forEach(p => consider(projectOntoRay(from, dir, p)));
    for (let j = 0; j < s.points.length; j++) {
      consider(raySegmentIntersection(from, dir, s.points[j], s.points[(j + 1) % s.points.length]));
    }
  });
  for (let j = 0; j < drawingPoints.length - 1; j++) {
    consider(projectOntoRay(from, dir, drawingPoints[j]));
    consider(raySegmentIntersection(from, dir, drawingPoints[j], drawingPoints[j + 1]));
  }

  const length = bestLength !== null ? bestLength : snapLengthForAngle(rawLength, angle, getSnapSize());
  angleLockSnapHit = bestLength !== null ? { x: from.x + dir.x * length, y: from.y + dir.y * length } : null;
  return { x: from.x + dir.x * length, y: from.y + dir.y * length };
}

// Point to use for the next polyline vertex/preview: angle-locked (Ctrl held) with the
// length free to snap onto other geometry, else aligned to an Alt-selected reference line
// when one is active, else angle-snapped relative to the previous point when that option
// is on, otherwise plain grid snap.
function nextDrawPoint(raw) {
  if (currentTool === 'line' && drawingPoints.length > 0) {
    const from = drawingPoints[drawingPoints.length - 1];
    if (angleLockActive && angleLockAngle !== null) return angleLockPoint(from, raw, angleLockAngle);
    if (refLineAngle !== null) return refAnglePoint(from, raw, refLineAngle);
    if (angleOnInput.checked) return angleSnapPoint(from, raw);
  }
  return snap(raw);
}

// ===========================================================================
// Drawing / rendering the 2D sketch
// ===========================================================================

function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#202124';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(viewOffset.x, viewOffset.y);
  ctx.scale(viewScale, viewScale);

  drawGrid(w, h);

  // reference outline of the face being sketched on, if any (fixed, non-interactive)
  if (faceEditContext) drawFaceReferenceOutline();

  // finished shapes
  shapes.forEach(shape => drawShape(shape, selectedShapeIds.has(shape.id)));

  if (currentTool === 'dimension') drawDimensionLabels();
  if (currentTool === 'point' || currentTool === 'origin') drawPointHandles();
  if (currentTool === 'edge') drawEdgeHandles();
  drawDragLabel();

  // reference line selected via Alt-click, while drawing
  if (currentTool === 'line' && refLineSeg) {
    ctx.save();
    ctx.strokeStyle = '#ff5f5f';
    ctx.lineWidth = 3 / viewScale;
    ctx.setLineDash([6 / viewScale, 4 / viewScale]);
    ctx.beginPath();
    ctx.moveTo(refLineSeg.a.x, refLineSeg.a.y);
    ctx.lineTo(refLineSeg.b.x, refLineSeg.b.y);
    ctx.stroke();
    ctx.restore();
  }

  // in-progress polygon
  if (currentTool === 'line' && drawingPoints.length > 0) {
    ctx.fillStyle = '#4a7dfc';
    ctx.lineWidth = 2 / viewScale;
    if (drawingPoints.length > 1) {
      ctx.strokeStyle = '#4a7dfc';
      ctx.beginPath();
      ctx.moveTo(drawingPoints[0].x, drawingPoints[0].y);
      for (let i = 1; i < drawingPoints.length; i++) ctx.lineTo(drawingPoints[i].x, drawingPoints[i].y);
      ctx.stroke();
    }
    let previewPoint = null;
    const last = drawingPoints[drawingPoints.length - 1];
    if (mousePos) {
      angleLockSnapHit = null;
      previewPoint = nextDrawPoint(mousePos);
      // the segment currently being dragged out is highlighted separately, so a locked
      // angle (Ctrl held) is visually distinguishable from freehand drawing
      ctx.strokeStyle = angleLockActive ? '#37e6b3' : '#4a7dfc';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(previewPoint.x, previewPoint.y);
      ctx.stroke();
    }
    drawingPoints.forEach(p => dot(p, '#4a7dfc'));
    dot(drawingPoints[0], '#ffcc55', 6); // highlight closing target

    if (previewPoint) {
      // live length of the segment currently being dragged out
      const mid = { x: (last.x + previewPoint.x) / 2, y: (last.y + previewPoint.y) / 2 };
      ctx.font = (11 / viewScale) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lenLabel = dist(last, previewPoint).toFixed(1) + ' mm' + (angleLockActive ? ' 🔒' : '');
      drawLabelBg(mid.x, mid.y, lenLabel);

      // highlight the point on another shape/segment the locked length snapped onto
      if (angleLockActive && angleLockSnapHit) dot(angleLockSnapHit, '#37e6b3', 6);
    }
  }

  // in-progress circle
  if (currentTool === 'circle' && circleCenter && mousePos) {
    const p = snap(mousePos);
    const r = dist(circleCenter, p);
    ctx.strokeStyle = '#4a7dfc';
    ctx.lineWidth = 2 / viewScale;
    ctx.beginPath();
    ctx.arc(circleCenter.x, circleCenter.y, r, 0, Math.PI * 2);
    ctx.stroke();
    dot(circleCenter, '#4a7dfc');
    drawLiveLabel(circleCenter.x, circleCenter.y - r - 12 / viewScale, 'R' + r.toFixed(1) + ' mm');
  }

  // in-progress rectangle / regular polygon
  if (isShapeTool(currentTool) && shapeStartPoint && mousePos) {
    const p = snap(mousePos);
    const pts = shapeToolPoints(currentTool, shapeStartPoint, p);
    ctx.strokeStyle = '#4a7dfc';
    ctx.lineWidth = 2 / viewScale;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    dot(shapeStartPoint, '#4a7dfc');

    const mid = { x: (shapeStartPoint.x + p.x) / 2, y: (shapeStartPoint.y + p.y) / 2 };
    if (currentTool === 'rect') {
      const w = Math.abs(p.x - shapeStartPoint.x);
      const h = Math.abs(p.y - shapeStartPoint.y);
      drawLiveLabel(mid.x, mid.y, w.toFixed(1) + ' x ' + h.toFixed(1) + ' mm');
    } else {
      const r = dist(shapeStartPoint, p);
      drawLiveLabel(shapeStartPoint.x, shapeStartPoint.y - r - 12 / viewScale, 'R' + r.toFixed(1) + ' mm');
    }
  }

  // text tool preview: ghost outline of the text at the (snapped) cursor position
  if (currentTool === 'text' && mousePos) {
    const p = snap(mousePos);
    const pieces = currentTextPieces(p);
    ctx.strokeStyle = textMode === 'cut' ? '#cc8b2c' : '#4a9eff';
    ctx.lineWidth = 2 / viewScale;
    ctx.setLineDash([5 / viewScale, 3 / viewScale]);
    pieces.forEach(piece => {
      ctx.beginPath();
      ctx.moveTo(piece.points[0].x, piece.points[0].y);
      for (let i = 1; i < piece.points.length; i++) ctx.lineTo(piece.points[i].x, piece.points[i].y);
      ctx.closePath();
      ctx.stroke();
    });
    ctx.setLineDash([]);
    dot(p, '#4a7dfc');
  }

  // hole-circle tool preview: ghost bolt-circle pattern at the (snapped) cursor position
  if (currentTool === 'holecircle' && mousePos) {
    const p = snap(mousePos);
    const holeRadius = Math.max(0.05, (parseFloat(document.getElementById('holecircle-diameter').value) || 5) / 2);
    const centers = holeCirclePieces(p);
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 2 / viewScale;
    ctx.setLineDash([5 / viewScale, 3 / viewScale]);
    centers.forEach(c => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, holeRadius, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    dot(p, '#4a7dfc');
    drawLiveLabel(p.x, p.y - holeRadius - 12 / viewScale, 'X ' + p.x.toFixed(1) + '  Y ' + p.y.toFixed(1));
  }

  ctx.restore();

  // Live X/Y read-out above the cursor, in screen space, whenever the mouse is
  // over the sketch canvas - independent of the active tool.
  if (mousePos) {
    const snapped = snap(mousePos);
    const screenPos = worldToScreen(snapped.x, snapped.y);
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const text = 'X ' + snapped.x.toFixed(1) + '  Y ' + snapped.y.toFixed(1);
    const paddingX = 6;
    const boxH = 18;
    const textW = ctx.measureText(text).width;
    const labelX = screenPos.x;
    const labelY = screenPos.y - 12;
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.fillRect(labelX - textW / 2 - paddingX, labelY - boxH, textW + paddingX * 2, boxH);
    ctx.fillStyle = '#ffcc55';
    ctx.fillText(text, labelX, labelY - 5);
  }

  updateZoomLabel();
}

function dot(p, color, r = 4) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r / viewScale, 0, Math.PI * 2);
  ctx.fill();
}

// Draws grid lines (and origin axes) across the currently visible world-space
// area. Must be called after the view transform (translate+scale) is applied.
function drawGrid(w, h) {
  if (!gridOnInput.checked) return;
  const g = getGridSize();
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);
  const xStart = Math.floor(topLeft.x / g) * g;
  const yStart = Math.floor(topLeft.y / g) * g;
  ctx.strokeStyle = '#2c2d30';
  ctx.lineWidth = 1 / viewScale;
  ctx.beginPath();
  for (let x = xStart; x <= bottomRight.x; x += g) { ctx.moveTo(x, topLeft.y); ctx.lineTo(x, bottomRight.y); }
  for (let y = yStart; y <= bottomRight.y; y += g) { ctx.moveTo(topLeft.x, y); ctx.lineTo(bottomRight.x, y); }
  ctx.stroke();
  // origin axes, only drawn while visible
  ctx.strokeStyle = '#40414a';
  ctx.beginPath();
  if (topLeft.x <= 0 && bottomRight.x >= 0) { ctx.moveTo(0, topLeft.y); ctx.lineTo(0, bottomRight.y); }
  if (topLeft.y <= 0 && bottomRight.y >= 0) { ctx.moveTo(topLeft.x, 0); ctx.lineTo(bottomRight.x, 0); }
  ctx.stroke();
}

function drawShape(shape, selected) {
  const color = shape.isHole ? '#cc8b2c' : shape.isAdditive ? '#4a9eff' : (selected ? '#ffcc55' : '#5fd06b');
  ctx.strokeStyle = color;
  ctx.lineWidth = (selected ? 3 : 2) / viewScale;
  ctx.beginPath();
  if (shape.type === 'polygon') {
    const pts = getFilletedPoints(shape);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  } else {
    ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.fillStyle = color + '22';
  ctx.fill();
}

// Draws the outline of the picked face (dashed, non-interactive) as a fixed
// reference underlay while sketching a face feature, so the user can see the
// face's boundary (and any pre-existing inner holes in it) while drawing.
function drawFaceReferenceOutline() {
  const drawLoop = (loop) => {
    if (!loop || loop.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(loop[0].x, loop[0].y);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
    ctx.closePath();
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = '#777';
  ctx.setLineDash([4 / viewScale, 3 / viewScale]);
  ctx.lineWidth = 1.5 / viewScale;
  drawLoop(faceEditContext.boundaryLoopUV);
  (faceEditContext.innerLoopsUV || []).forEach(drawLoop);
  ctx.restore();
}

function drawDimensionLabels() {
  ctx.font = (11 / viewScale) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  shapes.forEach(s => {
    if (s.type === 'polygon') {
      for (let j = 0; j < s.points.length; j++) {
        const a = s.points[j];
        const b = s.points[(j + 1) % s.points.length];
        drawLabelBg((a.x + b.x) / 2, (a.y + b.y) / 2, dist(a, b).toFixed(1) + ' mm');
      }
    } else {
      drawLabelBg(s.center.x, s.center.y - s.radius - 12 / viewScale, 'R' + s.radius.toFixed(1) + ' mm');
    }
  });
}

// Point mode: highlights every corner point (blue) and the center point (orange)
// of every shape, plus the overall center of any multi-piece group - text,
// hole-circle patterns, ... (teal, bigger - see groupCenterOf), as clickable
// targets for hitTestPoint().
function drawPointHandles() {
  const shownGroupCenters = new Set();
  shapes.forEach(s => {
    if (s.type === 'polygon') {
      s.points.forEach(p => dot(p, '#4a7dfc', 5));
      dot(centroidOf(s), '#ff9f4a', 5);
    } else {
      dot(s.center, '#ff9f4a', 5);
    }
    if (s.groupId != null && !shownGroupCenters.has(s.groupId)) {
      shownGroupCenters.add(s.groupId);
      const c = groupCenterOf(s.groupId);
      if (c) dot(c, '#37e6b3', 6);
    }
  });
}

// Edge mode: highlights every clickable line (polygon edges only - circles
// have no corners to round) and marks corners that already have a fillet
// radius, as clickable targets for hitTestSegment()/the "Rundung" editor.
function drawEdgeHandles() {
  ctx.strokeStyle = '#37e6b3';
  ctx.lineWidth = 3 / viewScale;
  shapes.forEach(s => {
    if (s.type !== 'polygon') return;
    for (let j = 0; j < s.points.length; j++) {
      const a = s.points[j];
      const b = s.points[(j + 1) % s.points.length];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (s.filletRadii) {
      Object.keys(s.filletRadii).forEach(idx => dot(s.points[idx], '#ffcc55', 5));
    }
  });
}

// Live dimension readout while a shape is being dragged out (line length, circle
// radius, rect size, polygon radius) - sets up the font/alignment drawLabelBg
// expects, so callers can just pass a position and the text to show.
function drawLiveLabel(x, y, text) {
  ctx.font = (11 / viewScale) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawLabelBg(x, y, text);
}

// x, y, and text are all in world space; padding/height are kept a constant
// screen size by dividing by viewScale, so labels don't balloon when zoomed in.
function drawLabelBg(x, y, text) {
  const padding = 4 / viewScale;
  const h = 16 / viewScale;
  const w = ctx.measureText(text).width + padding * 2;
  ctx.fillStyle = 'rgba(20,20,20,0.85)';
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  ctx.fillStyle = '#ffcc55';
  ctx.fillText(text, x, y);
}

function drawDragLabel() {
  if (!dragState || !dragState.moved) return;
  const shape = shapes.find(s => s.id === dragState.primaryId);
  if (!shape) return;
  ctx.font = (11 / viewScale) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const c = centroidOf(shape);
  const offsetY = (shape.type === 'circle' ? shape.radius : 0) + 20 / viewScale;
  const label = `Δx ${dragState.dx.toFixed(1)} mm   Δy ${dragState.dy.toFixed(1)} mm`;
  drawLabelBg(c.x, c.y - offsetY, label);
}

// ===========================================================================
// Sketch interaction
// ===========================================================================

function setTool(tool) {
  currentTool = tool;
  cancelInProgress();
  closeLengthEditor(true);
  closePointEditor(true);
  closeFilletEditor(true);
  endDrag();
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-' + tool).classList.add('active');
  document.getElementById('text-panel-block').style.display = (tool === 'text') ? 'block' : 'none';
  document.getElementById('holecircle-panel-block').style.display = (tool === 'holecircle') ? 'block' : 'none';
  canvas.style.cursor = (tool === 'select' || tool === 'dimension' || tool === 'point' || tool === 'edge' || tool === 'origin') ? 'pointer' : 'crosshair';
  render();
}

function cancelInProgress() {
  drawingPoints = [];
  circleCenter = null;
  shapeStartPoint = null;
  refLineAngle = null;
  refLineSeg = null;
  angleLockActive = false;
  angleLockAngle = null;
  angleLockSnapHit = null;
}

function finishPolygon() {
  if (drawingPoints.length >= 3) {
    pushHistory();
    shapes.push({ id: nextShapeId++, type: 'polygon', points: drawingPoints.slice(), isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: 'top', holeDepth: 5 });
    onShapesChanged();
  }
  drawingPoints = [];
  refLineAngle = null;
  refLineSeg = null;
  angleLockActive = false;
  angleLockAngle = null;
  angleLockSnapHit = null;
  render();
}

function markDirty() {
  btnExport.disabled = true;
  extrudeStatusEl.textContent = '';
  if (extrudedGroup) {
    viewerScene.remove(extrudedGroup);
    extrudedGroup = null;
  }
  updateFaceEditUI();
}

function onShapesChanged() {
  renderShapeList();
  // While sketching a face feature, the base solid already on screen is still
  // valid (nothing about it changed) - only invalidate/clear it for edits to
  // the base sketch itself.
  if (!faceEditContext) markDirty();
}

canvas.addEventListener('mousemove', (evt) => {
  mousePos = getMousePos(evt);
  if (dragState) updateDrag(mousePos);
  render();
});

canvas.addEventListener('mouseleave', () => {
  mousePos = null;
  render();
});

// Mouse wheel: zoom in/out, keeping the world point under the cursor stationary on screen.
canvas.addEventListener('wheel', (evt) => {
  evt.preventDefault();
  closeLengthEditor(true);
  closePointEditor(true);
  closeFilletEditor(true);
  const rect = canvas.getBoundingClientRect();
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  const worldBefore = screenToWorld(sx, sy);
  const factor = Math.pow(1.15, -evt.deltaY / 100);
  viewScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewScale * factor));
  viewOffset.x = sx - worldBefore.x * viewScale;
  viewOffset.y = sy - worldBefore.y * viewScale;
  render();
}, { passive: false });

// Middle-mouse-button drag: pan the view.
canvas.addEventListener('mousedown', (evt) => {
  if (evt.button !== 1) return;
  evt.preventDefault();
  closeLengthEditor(true);
  closePointEditor(true);
  closeFilletEditor(true);
  panState = { startX: evt.clientX, startY: evt.clientY, startOffset: { x: viewOffset.x, y: viewOffset.y } };
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (evt) => {
  if (!panState) return;
  viewOffset.x = panState.startOffset.x + (evt.clientX - panState.startX);
  viewOffset.y = panState.startOffset.y + (evt.clientY - panState.startY);
  render();
});

function endPan() {
  if (!panState) return;
  panState = null;
  canvas.style.cursor = (currentTool === 'select' || currentTool === 'dimension') ? 'pointer' : 'crosshair';
}

function updateZoomLabel() {
  const el = document.getElementById('zoom-label');
  if (el) el.textContent = 'Zoom: ' + Math.round(viewScale * 100) + '%';
}

// Centers the sketch view so the world origin (0,0) sits in the middle of the
// canvas instead of the default top-left corner - otherwise a fresh sketch
// (or a view reset) only shows the single quadrant where x>=0 and y>=0,
// instead of all four quadrants around the origin.
function centerView() {
  viewOffset = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
}

document.getElementById('btn-reset-view').addEventListener('click', () => {
  viewScale = 1;
  centerView();
  render();
});

canvas.addEventListener('mousedown', (evt) => {
  if (currentTool !== 'select' || evt.button !== 0) return;
  const raw = getMousePos(evt);
  const hit = hitTestShape(raw);

  if (evt.ctrlKey || evt.metaKey) {
    // Ctrl/Cmd-click toggles one shape's membership in the selection without
    // starting a drag, so a multi-selection can be built up click by click.
    if (hit) {
      if (selectedShapeIds.has(hit.id)) selectedShapeIds.delete(hit.id);
      else selectedShapeIds.add(hit.id);
      renderShapeList();
      render();
    }
    return;
  }

  if (!hit) {
    selectedShapeIds.clear();
    renderShapeList();
    render();
    return;
  }

  // Clicking a shape that's already part of the current multi-selection keeps
  // the whole selection (so it can be dragged together); clicking anything
  // else collapses the selection down to just that one shape.
  if (!selectedShapeIds.has(hit.id)) selectedShapeIds = new Set([hit.id]);
  renderShapeList();

  // Drag every selected shape, plus each one's own group-mates (text-tool
  // letters, hole-circle patterns - see `groupId`), all together.
  const dragIds = new Set();
  selectedShapeIds.forEach(id => {
    dragIds.add(id);
    const s = shapes.find(sh => sh.id === id);
    if (s && s.groupId != null) shapes.filter(sh => sh.groupId === s.groupId).forEach(sh => dragIds.add(sh.id));
  });
  const idsArr = Array.from(dragIds);
  dragState = {
    primaryId: hit.id,
    shapeIds: idsArr,
    originals: idsArr.map(id => JSON.parse(JSON.stringify(shapes.find(s => s.id === id)))),
    startRaw: raw, dx: 0, dy: 0, moved: false,
  };
  canvas.style.cursor = 'grabbing';
  render();
});

function updateDrag(raw) {
  const g = getSnapSize();
  const dx = snapValue(raw.x - dragState.startRaw.x, g);
  const dy = snapValue(raw.y - dragState.startRaw.y, g);
  if (dx === 0 && dy === 0) return;
  if (!dragState.moved) {
    pushHistory(); // snapshot taken once, right before the shape actually starts moving
    dragState.moved = true;
  }
  dragState.dx = dx;
  dragState.dy = dy;
  dragState.shapeIds.forEach((id, idx) => {
    const shape = shapes.find(s => s.id === id);
    if (!shape) return;
    const orig = dragState.originals[idx];
    if (shape.type === 'circle') {
      shape.center = { x: orig.center.x + dx, y: orig.center.y + dy };
    } else {
      shape.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    }
  });
  markDirty();
}

function endDrag() {
  if (!dragState) return;
  if (dragState.moved) onShapesChanged();
  dragState = null;
  canvas.style.cursor = 'pointer';
  render();
}

window.addEventListener('mouseup', () => { endDrag(); endPan(); });

canvas.addEventListener('click', (evt) => {
  const raw = getMousePos(evt);

  if (currentTool === 'line' && evt.altKey) {
    // Alt-click an existing line segment - either from a finished shape or from the
    // polyline currently being drawn - to use it as a reference: the segment currently
    // being drawn snaps to the same angle instead of placing a vertex.
    const drawingHit = hitTestDrawingSegment(raw);
    if (drawingHit) {
      refLineAngle = Math.atan2(drawingHit.b.y - drawingHit.a.y, drawingHit.b.x - drawingHit.a.x);
      refLineSeg = drawingHit;
      render();
      return;
    }
    const hit = hitTestSegment(raw);
    if (hit && hit.segIndex !== null) {
      const a = hit.shape.points[hit.segIndex];
      const b = hit.shape.points[(hit.segIndex + 1) % hit.shape.points.length];
      refLineAngle = Math.atan2(b.y - a.y, b.x - a.x);
      refLineSeg = { a, b };
      render();
    }
    return;
  }

  if (currentTool === 'line') {
    if (drawingPoints.length >= 3 && dist(raw, drawingPoints[0]) <= CLOSE_SNAP_PX / viewScale) {
      finishPolygon();
      return;
    }
    drawingPoints.push(nextDrawPoint(raw));
    // the reference-line constraint only applies to the segment it was selected for;
    // once that segment is placed, drop back to freehand drawing
    if (refLineAngle !== null) {
      refLineAngle = null;
      refLineSeg = null;
    }
    render();
  } else if (currentTool === 'circle') {
    const p = snap(raw);
    if (!circleCenter) {
      circleCenter = p;
    } else {
      const r = dist(circleCenter, p);
      if (r > 0) {
        pushHistory();
        shapes.push({ id: nextShapeId++, type: 'circle', center: circleCenter, radius: r, isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: 'top', holeDepth: 5 });
        onShapesChanged();
      }
      circleCenter = null;
    }
    render();
  } else if (isShapeTool(currentTool)) {
    const p = snap(raw);
    if (!shapeStartPoint) {
      shapeStartPoint = p;
    } else {
      if (p.x !== shapeStartPoint.x || p.y !== shapeStartPoint.y) {
        pushHistory();
        shapes.push({ id: nextShapeId++, type: 'polygon', kind: currentTool, points: shapeToolPoints(currentTool, shapeStartPoint, p), isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: 'top', holeDepth: 5 });
        onShapesChanged();
      }
      shapeStartPoint = null;
    }
    render();
  } else if (currentTool === 'text') {
    const p = snap(raw);
    const pieces = currentTextPieces(p);
    if (pieces.length > 0) {
      pushHistory();
      const groupId = nextShapeId;
      const heightVal = Math.max(0.1, parseFloat(document.getElementById('text-height').value) || 3);
      pieces.forEach(piece => {
        shapes.push({
          id: nextShapeId++,
          type: 'polygon',
          kind: 'text',
          char: piece.char,
          groupId,
          points: piece.points,
          isHole: textMode === 'cut',
          isAdditive: textMode === 'extrude',
          additiveHeight: heightVal,
          additiveSide: textSide,
          holeDepth: heightVal,
        });
      });
      onShapesChanged();
    }
    render();
  } else if (currentTool === 'holecircle') {
    const p = snap(raw);
    const pieces = holeCirclePieces(p);
    if (pieces.length > 0) {
      pushHistory();
      const groupId = nextShapeId;
      pieces.forEach(center => {
        shapes.push({
          id: nextShapeId++,
          type: 'circle',
          kind: 'holecircle',
          groupId,
          center,
          radius: Math.max(0.05, (parseFloat(document.getElementById('holecircle-diameter').value) || 5) / 2),
          isHole: false,
          isAdditive: true,
          additiveHeight: 5,
          additiveSide: 'top',
          holeDepth: 5,
        });
      });
      onShapesChanged();
    }
    setTool('point');
    return;
  } else if (currentTool === 'dimension') {
    const hit = hitTestSegment(raw);
    if (hit) openLengthEditor(hit);
  } else if (currentTool === 'point') {
    const hit = hitTestPoint(raw);
    if (hit) openPointEditor(hit);
    else closePointEditor(true);
  } else if (currentTool === 'origin') {
    const hit = hitTestPoint(raw);
    if (hit) {
      setOriginToPoint(hit.point);
      setTool('select');
    }
  } else if (currentTool === 'edge') {
    const hit = hitTestSegment(raw);
    if (hit && hit.shape.type === 'polygon' && hit.segIndex !== null) {
      const n = hit.shape.points.length;
      const a = hit.shape.points[hit.segIndex];
      const b = hit.shape.points[(hit.segIndex + 1) % n];
      // Round whichever end of the clicked line the click landed closer to.
      const vertexIndex = dist(raw, a) <= dist(raw, b) ? hit.segIndex : (hit.segIndex + 1) % n;
      openFilletEditor({ shape: hit.shape, vertexIndex, point: hit.shape.points[vertexIndex] });
    } else {
      closeFilletEditor(true);
    }
  }
});

canvas.addEventListener('dblclick', (evt) => {
  evt.preventDefault();
  if (currentTool === 'line') finishPolygon();
});

document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Enter' && currentTool === 'line') finishPolygon();
  if (evt.key === 'Escape') { cancelInProgress(); render(); }
  if ((evt.key === 'Delete' || evt.key === 'Backspace') && selectedShapeIds.size > 0) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack text editing
    evt.preventDefault();
    deleteShapes(Array.from(selectedShapeIds));
  }
  // Ctrl held while drawing a line: lock the segment's current angle so only its length
  // still follows the mouse, snapping onto other lines to determine that length.
  if (evt.key === 'Control' && currentTool === 'line' && drawingPoints.length > 0 && !angleLockActive && mousePos) {
    const from = drawingPoints[drawingPoints.length - 1];
    const current = nextDrawPoint(mousePos);
    angleLockAngle = Math.atan2(current.y - from.y, current.x - from.x);
    angleLockActive = true;
    render();
  }
});

document.addEventListener('keyup', (evt) => {
  if (evt.key === 'Control' && angleLockActive) {
    angleLockActive = false;
    angleLockAngle = null;
    angleLockSnapHit = null;
    render();
  }
});

function deleteShape(id) {
  deleteShapes([id]);
}

function deleteShapes(ids) {
  if (ids.length === 0) return;
  pushHistory();
  const idSet = new Set(ids);
  shapes = shapes.filter(sh => !idSet.has(sh.id));
  idSet.forEach(id => selectedShapeIds.delete(id));
  onShapesChanged();
  render();
}

function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function hitTestShape(pt) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'circle') {
      if (dist(pt, s.center) <= s.radius) return s;
    } else if (pointInPolygon(pt, s.points)) {
      return s;
    }
  }
  return null;
}

function distToSegment(p, a, b) {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

// ===========================================================================
// Corner rounding ("Rundung"): a shape's raw `points` stay the sharp-corner
// source of truth (so dragging/point-editing/hit-testing keep working
// unchanged) - `filletRadii` is a sparse {vertexIndex: radiusMm} map, and
// getFilletedPoints() derives the actual rendered/extruded outline (sharp
// corners replaced by tangent arcs) on demand. Only 2D rendering and 3D
// extrusion read the derived outline; everything else keeps using the plain
// vertex list.
// ===========================================================================

// Replaces vertex `curr` (between `prev` and `next`) with an arc of the given
// radius, tangent to both adjacent edges - the classic corner-fillet
// construction. Works the same way for reflex/concave corners as for convex
// ones: the tangent-length/center-distance formulas below only depend on the
// angle between the two edges at `curr`, not on which side is "inside" the
// polygon, so no separate convex/reflex case is needed.
function filletCornerArc(prev, curr, next, radius) {
  const v1x = prev.x - curr.x, v1y = prev.y - curr.y;
  const v2x = next.x - curr.x, v2y = next.y - curr.y;
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-9 || len2 < 1e-9) return [curr];
  const u1x = v1x / len1, u1y = v1y / len1;
  const u2x = v2x / len2, u2y = v2y / len2;
  const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
  const angle = Math.acos(dot);
  if (angle < 1e-4 || angle > Math.PI - 1e-4) return [curr]; // (near-)straight or folded-back corner - nothing sensible to round

  // Tangent length from the corner to each arc endpoint - clamped so a radius
  // too large for the adjacent edges gracefully shrinks to the biggest that
  // still fits, instead of producing a self-overlapping mess.
  const tangentLen = Math.min(radius / Math.tan(angle / 2), len1 * 0.999, len2 * 0.999);
  const actualRadius = tangentLen * Math.tan(angle / 2);
  if (actualRadius < 1e-6) return [curr];

  const p1 = { x: curr.x + u1x * tangentLen, y: curr.y + u1y * tangentLen };
  const p2 = { x: curr.x + u2x * tangentLen, y: curr.y + u2y * tangentLen };

  let bx = u1x + u2x, by = u1y + u2y;
  const blen = Math.hypot(bx, by);
  if (blen < 1e-9) { bx = -u1y; by = u1x; } else { bx /= blen; by /= blen; }

  // The center always sits on the angle-bisector side of curr, at the
  // distance that keeps it exactly `actualRadius` from both p1 and p2 (this
  // falls out of the tangent-length formula above regardless of whether the
  // corner is convex or reflex - flipping it to "the other side" for reflex
  // corners would NOT keep p1/p2 on the resulting circle, so don't).
  const centerDist = actualRadius / Math.sin(angle / 2);
  const center = { x: curr.x + bx * centerDist, y: curr.y + by * centerDist };

  const a1 = Math.atan2(p1.y - center.y, p1.x - center.x);
  const a2 = Math.atan2(p2.y - center.y, p2.x - center.x);
  let diff = a2 - a1;
  while (diff <= -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;

  const steps = Math.max(2, Math.round((Math.abs(diff) / (Math.PI / 2)) * 8));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a1 + diff * (i / steps);
    pts.push({ x: center.x + actualRadius * Math.cos(a), y: center.y + actualRadius * Math.sin(a) });
  }
  return pts;
}

// The outline actually used for 2D rendering and 3D extrusion: sharp corners
// listed in `shape.filletRadii` replaced by their tangent arc. Falls back to
// the plain `shape.points` untouched when there's nothing to round (the
// overwhelmingly common case), so this is cheap to call on every render.
function getFilletedPoints(shape) {
  if (shape.type !== 'polygon' || !shape.filletRadii) return shape.points;
  const keys = Object.keys(shape.filletRadii);
  if (keys.length === 0) return shape.points;
  const pts = shape.points;
  const n = pts.length;
  const result = [];
  for (let i = 0; i < n; i++) {
    const r = shape.filletRadii[i];
    if (!r || r <= 0) { result.push(pts[i]); continue; }
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    filletCornerArc(prev, pts[i], next, r).forEach(p => result.push(p));
  }
  return result;
}

function hitTestSegment(pt) {
  const threshold = SEGMENT_HIT_PX / viewScale;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'polygon') {
      for (let j = 0; j < s.points.length; j++) {
        const a = s.points[j];
        const b = s.points[(j + 1) % s.points.length];
        if (distToSegment(pt, a, b) <= threshold) {
          return { shape: s, segIndex: j, midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        }
      }
    } else if (s.type === 'circle') {
      if (Math.abs(dist(pt, s.center) - s.radius) <= threshold) {
        const a = Math.atan2(pt.y - s.center.y, pt.x - s.center.x);
        return {
          shape: s, segIndex: null,
          midpoint: { x: s.center.x + Math.cos(a) * s.radius, y: s.center.y + Math.sin(a) * s.radius }
        };
      }
    }
  }
  return null;
}

// Checks the segments of the polyline currently being drawn (drawingPoints), so an
// Alt-click can pick a reference line from the in-progress shape too, not just from
// already-finished shapes. Searches most-recent segment first.
function hitTestDrawingSegment(pt) {
  if (drawingPoints.length < 2) return null;
  const threshold = SEGMENT_HIT_PX / viewScale;
  for (let j = drawingPoints.length - 2; j >= 0; j--) {
    const a = drawingPoints[j];
    const b = drawingPoints[j + 1];
    if (distToSegment(pt, a, b) <= threshold) return { a, b };
  }
  return null;
}

// Point mode: finds the nearest corner point or center point (whichever
// hitTestSegment-style threshold hits first) to `pt`, checking topmost shape first.
// The overall center of a group of shapes (e.g. a hole-circle pattern) -
// the average of every member's own centroid/center. For a bolt-circle
// pattern (circles evenly spaced around a common point) this lands exactly
// back on that original placement point.
function groupCenterOf(groupId) {
  const members = shapes.filter(s => s.groupId === groupId);
  if (members.length === 0) return null;
  const sum = members.reduce((a, s) => {
    const c = centroidOf(s);
    return { x: a.x + c.x, y: a.y + c.y };
  }, { x: 0, y: 0 });
  return { x: sum.x / members.length, y: sum.y / members.length };
}

function hitTestPoint(pt) {
  const threshold = POINT_HIT_PX / viewScale;

  // Checked first, ahead of individual vertices/centers: a group's overall
  // center (hole-circle patterns, multi-letter text, ...) is a deliberate,
  // separate click target for repositioning/rotating the whole group as a
  // unit - but text in particular flattens glyph curves into many
  // closely-packed vertices, so the group center can easily land within the
  // hit threshold of some unrelated letter's own vertex. Giving the group
  // center priority means clicking it always finds it, regardless of what
  // else happens to be nearby.
  const checkedGroups = new Set();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.groupId == null || checkedGroups.has(s.groupId)) continue;
    checkedGroups.add(s.groupId);
    const c = groupCenterOf(s.groupId);
    if (c && dist(pt, c) <= threshold) {
      return { shape: s, kind: 'groupcenter', groupId: s.groupId, index: null, point: c };
    }
  }

  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'polygon') {
      for (let j = 0; j < s.points.length; j++) {
        if (dist(pt, s.points[j]) <= threshold) {
          return { shape: s, kind: 'vertex', index: j, point: s.points[j] };
        }
      }
      const c = centroidOf(s);
      if (dist(pt, c) <= threshold) {
        return { shape: s, kind: 'center', index: null, point: c };
      }
    } else if (s.type === 'circle') {
      if (dist(pt, s.center) <= threshold) {
        return { shape: s, kind: 'center', index: null, point: s.center };
      }
    }
  }
  return null;
}

function closeLengthEditor(apply) {
  if (!dimEditor) return;
  const { input, wrap, hit, anchor } = dimEditor;
  dimEditor = null; // clear first so the blur triggered by remove() below doesn't recurse
  if (apply) {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) applyLength(hit, val, anchor);
  }
  wrap.remove();
  render();
}

// anchor 'a' keeps the segment's start point (points[segIndex]) fixed and moves the end point;
// anchor 'b' keeps the end point fixed and moves the start point instead.
function applyLength(hit, newLength, anchor) {
  const s = hit.shape;
  if (s.type === 'circle') {
    pushHistory();
    s.radius = newLength;
    onShapesChanged();
    return;
  }
  const ia = hit.segIndex;
  const ib = (hit.segIndex + 1) % s.points.length;
  const fixedIdx = anchor === 'b' ? ib : ia;
  const movingIdx = anchor === 'b' ? ia : ib;
  const fixed = s.points[fixedIdx];
  const moving = s.points[movingIdx];
  const curLen = dist(fixed, moving);
  if (curLen === 0) return;
  pushHistory();
  const ux = (moving.x - fixed.x) / curLen;
  const uy = (moving.y - fixed.y) / curLen;
  moving.x = fixed.x + ux * newLength;
  moving.y = fixed.y + uy * newLength;
  onShapesChanged();
}

function openLengthEditor(hit) {
  closeLengthEditor(true);
  const s = hit.shape;
  const isLine = hit.segIndex !== null;
  const currentLength = isLine ? dist(s.points[hit.segIndex], s.points[(hit.segIndex + 1) % s.points.length]) : s.radius;

  const screenPos = worldToScreen(hit.midpoint.x, hit.midpoint.y);
  const wrap = document.createElement('div');
  wrap.className = 'dim-editor-wrap';
  wrap.style.left = (canvas.offsetLeft + screenPos.x) + 'px';
  wrap.style.top = (canvas.offsetTop + screenPos.y) + 'px';

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'dim-editor';
  input.step = '0.1';
  input.min = '0.1';
  input.value = currentLength.toFixed(1);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') closeLengthEditor(true);
    else if (e.key === 'Escape') closeLengthEditor(false);
  });
  input.addEventListener('blur', () => closeLengthEditor(true));

  if (isLine) {
    const btnA = document.createElement('button');
    btnA.type = 'button';
    btnA.className = 'dim-anchor-btn active';
    btnA.textContent = '-|';
    btnA.title = 'Startpunkt bleibt fix, Endpunkt verändert sich';

    const btnB = document.createElement('button');
    btnB.type = 'button';
    btnB.className = 'dim-anchor-btn';
    btnB.textContent = '|-';
    btnB.title = 'Endpunkt bleibt fix, Startpunkt verändert sich';

    const selectAnchor = (anchor) => {
      dimEditor.anchor = anchor;
      btnA.classList.toggle('active', anchor === 'a');
      btnB.classList.toggle('active', anchor === 'b');
      input.focus();
    };
    // keep focus on the input so the anchor click doesn't trigger the input's blur-close
    btnA.addEventListener('mousedown', (e) => e.preventDefault());
    btnB.addEventListener('mousedown', (e) => e.preventDefault());
    btnA.addEventListener('click', () => selectAnchor('a'));
    btnB.addEventListener('click', () => selectAnchor('b'));

    wrap.appendChild(btnA);
    wrap.appendChild(input);
    wrap.appendChild(btnB);
  } else {
    wrap.appendChild(input);
  }

  document.getElementById('sketch-pane').appendChild(wrap);
  dimEditor = { input, wrap, hit, anchor: 'a' };
  input.focus();
  input.select();
}

function closePointEditor(apply) {
  if (!pointEditor) return;
  const { inputX, inputY, inputRotation, wrap, hit } = pointEditor;
  pointEditor = null; // clear first so the blur triggered by remove() below doesn't recurse
  if (apply) {
    const x = parseFloat(inputX.value);
    const y = parseFloat(inputY.value);
    const rotation = inputRotation ? (parseFloat(inputRotation.value) || 0) : 0;
    if (!isNaN(x) && !isNaN(y)) applyPoint(hit, x, y, rotation);
  }
  wrap.remove();
  render();
}

// Vertices move directly to the new coordinate. Center points move a circle's
// stored center directly, but for a polygon there is no stored center - moving
// its centroid instead translates every vertex by the same delta. A
// group-center hit (e.g. a hole-circle pattern or a placed text) shifts every
// member of the group by the same delta, keeping its shape intact.
// `rotationDeg` (from the point editor's Rotation field, if shown - see
// openPointEditor) is a relative "rotate by this much" delta, not a stored
// absolute orientation: it's applied around the *original* center/group-center
// (which rotation leaves in place) before that center is then moved to (x,y),
// so both fields can be changed together in one go.
function applyPoint(hit, x, y, rotationDeg = 0) {
  const s = hit.shape;
  pushHistory();
  if (hit.kind === 'vertex') {
    s.points[hit.index] = { x, y };
  } else if (hit.kind === 'groupcenter') {
    const members = shapes.filter(sh => sh.groupId === hit.groupId);
    if (rotationDeg) members.forEach(sh => rotateShapeAround(sh, hit.point, rotationDeg));
    const dx = x - hit.point.x;
    const dy = y - hit.point.y;
    members.forEach(sh => {
      if (sh.type === 'circle') sh.center = { x: sh.center.x + dx, y: sh.center.y + dy };
      else sh.points = sh.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    });
  } else if (s.type === 'circle') {
    s.center = { x, y };
  } else {
    if (rotationDeg) rotateShapeAround(s, hit.point, rotationDeg);
    const c = centroidOf(s); // rotating around its own centroid leaves the centroid in place, so this is still hit.point - recomputed for clarity
    const dx = x - c.x;
    const dy = y - c.y;
    s.points = s.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
  }
  onShapesChanged();
}

// Shifts every shape so that `point` (in its current world coordinates) becomes
// the new world origin (0,0) - i.e. translates all geometry by (-point.x, -point.y).
function setOriginToPoint(point) {
  const dx = point.x;
  const dy = point.y;
  if (dx === 0 && dy === 0) return;
  pushHistory();
  shapes.forEach(s => {
    if (s.type === 'polygon') {
      s.points = s.points.map(p => ({ x: p.x - dx, y: p.y - dy }));
    } else {
      s.center = { x: s.center.x - dx, y: s.center.y - dy };
    }
  });
  onShapesChanged();
  render();
}

function openPointEditor(hit) {
  closePointEditor(true);

  const screenPos = worldToScreen(hit.point.x, hit.point.y);
  const wrap = document.createElement('div');
  wrap.className = 'point-editor-wrap';
  wrap.style.left = (canvas.offsetLeft + screenPos.x) + 'px';
  wrap.style.top = (canvas.offsetTop + screenPos.y) + 'px';

  const btnOrigin = document.createElement('button');
  btnOrigin.type = 'button';
  btnOrigin.className = 'origin-btn';
  btnOrigin.textContent = '⌂';
  btnOrigin.title = 'Diesen Punkt als neuen Ursprung (0,0) setzen';
  // keep focus in the inputs so this click doesn't trigger their blur-close first
  btnOrigin.addEventListener('mousedown', (e) => e.preventDefault());
  btnOrigin.addEventListener('click', () => {
    const p = hit.point;
    closePointEditor(false);
    setOriginToPoint(p);
  });
  wrap.appendChild(btnOrigin);

  const labelX = document.createElement('span');
  labelX.className = 'point-editor-label';
  labelX.textContent = 'X';

  const inputX = document.createElement('input');
  inputX.type = 'number';
  inputX.className = 'point-editor';
  inputX.step = '0.1';
  inputX.value = hit.point.x.toFixed(1);

  const labelY = document.createElement('span');
  labelY.className = 'point-editor-label';
  labelY.textContent = 'Y';

  const inputY = document.createElement('input');
  inputY.type = 'number';
  inputY.className = 'point-editor';
  inputY.step = '0.1';
  inputY.value = hit.point.y.toFixed(1);

  wrap.appendChild(labelX);
  wrap.appendChild(inputX);
  wrap.appendChild(labelY);
  wrap.appendChild(inputY);

  // Rotation only makes sense around a shape's/group's own center - a single
  // vertex or a lone (non-grouped) circle's own center have no orientation to
  // turn. Unlike X/Y (an absolute target position, pre-filled with the
  // current value), this is a relative "rotate by this many degrees" action -
  // there's no meaningful "current absolute angle" to show for an arbitrary
  // hand-drawn shape, so it always starts blank and is applied once, then done.
  const canRotate = hit.kind === 'groupcenter' || (hit.kind === 'center' && hit.shape.type === 'polygon');
  let inputRotation = null;
  if (canRotate) {
    const labelR = document.createElement('span');
    labelR.className = 'point-editor-label';
    labelR.textContent = '⟳';
    labelR.title = 'Um diesen Winkel drehen (Grad, im Uhrzeigersinn)';

    inputRotation = document.createElement('input');
    inputRotation.type = 'number';
    inputRotation.className = 'point-editor';
    inputRotation.step = '1';
    inputRotation.placeholder = '0°';
    inputRotation.title = labelR.title;

    wrap.appendChild(labelR);
    wrap.appendChild(inputRotation);
  }

  const fields = [inputX, inputY].concat(inputRotation ? [inputRotation] : []);
  const onKeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') closePointEditor(true);
    else if (e.key === 'Escape') closePointEditor(false);
  };
  // only close when focus leaves all of the editor's own fields, so tabbing between them doesn't close it
  const onBlur = (e) => { if (!fields.includes(e.relatedTarget)) closePointEditor(true); };
  fields.forEach(f => { f.addEventListener('keydown', onKeydown); f.addEventListener('blur', onBlur); });

  document.getElementById('sketch-pane').appendChild(wrap);
  pointEditor = { inputX, inputY, inputRotation, wrap, hit };
  inputX.focus();
  inputX.select();
}

function closeFilletEditor(apply) {
  if (!filletEditor) return;
  const { input, wrap, hit } = filletEditor;
  filletEditor = null; // clear first so the blur triggered by remove() below doesn't recurse
  if (apply) {
    const val = parseFloat(input.value);
    applyFillet(hit, !isNaN(val) && val > 0 ? val : 0);
  }
  wrap.remove();
  render();
}

// radius <= 0 removes the fillet, restoring the sharp corner.
function applyFillet(hit, radius) {
  const s = hit.shape;
  pushHistory();
  if (!s.filletRadii) s.filletRadii = {};
  if (radius > 0) s.filletRadii[hit.vertexIndex] = radius;
  else delete s.filletRadii[hit.vertexIndex];
  onShapesChanged();
}

function openFilletEditor(hit) {
  closeFilletEditor(true);
  const s = hit.shape;
  const current = (s.filletRadii && s.filletRadii[hit.vertexIndex]) || 0;

  const screenPos = worldToScreen(hit.point.x, hit.point.y);
  const wrap = document.createElement('div');
  wrap.className = 'dim-editor-wrap';
  wrap.style.left = (canvas.offsetLeft + screenPos.x) + 'px';
  wrap.style.top = (canvas.offsetTop + screenPos.y) + 'px';

  const label = document.createElement('span');
  label.className = 'dim-anchor-btn';
  label.style.cursor = 'default';
  label.title = 'Eckenradius (0 = scharfe Ecke)';
  label.textContent = '⌒';
  wrap.appendChild(label);

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'dim-editor';
  input.step = '0.1';
  input.min = '0';
  input.placeholder = '0';
  input.value = current > 0 ? current.toFixed(1) : '';
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') closeFilletEditor(true);
    else if (e.key === 'Escape') closeFilletEditor(false);
  });
  input.addEventListener('blur', () => closeFilletEditor(true));
  wrap.appendChild(input);

  document.getElementById('sketch-pane').appendChild(wrap);
  filletEditor = { input, wrap, hit };
  input.focus();
  input.select();
}

// ===========================================================================
// Shape list panel
// ===========================================================================

const SHAPE_KIND_LABELS = { rect: 'Rechteck', poly3: 'Dreieck', poly5: 'Fünfeck', poly6: 'Sechseck', poly8: 'Achteck', text: 'Text' };

function shapeLabel(s) {
  if (s.kind === 'holecircle') return 'Lochkreis-Loch';
  if (s.type === 'circle') return 'Kreis';
  if (s.kind === 'text') return `Text „${s.char}“`;
  return SHAPE_KIND_LABELS[s.kind] || 'Linienform';
}

function centroidOf(shape) {
  if (shape.type === 'circle') return { x: shape.center.x, y: shape.center.y };
  const n = shape.points.length;
  const sum = shape.points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / n, y: sum.y / n };
}

// Rotates `p` around `center` by `angleDeg` degrees. Positive = clockwise on
// screen (world Y grows downward, same convention as CSS/canvas transforms).
function rotatePoint(p, center, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p.x - center.x, dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

// Rotates a whole shape's own geometry around `center` in place. A circle
// only has a center point (rotating a circle around itself is a no-op unless
// that center is itself off the rotation pivot, e.g. one hole of a bolt-circle
// pattern rotating around the pattern's shared center).
function rotateShapeAround(shape, center, angleDeg) {
  if (shape.type === 'circle') {
    shape.center = rotatePoint(shape.center, center, angleDeg);
  } else {
    shape.points = shape.points.map(p => rotatePoint(p, center, angleDeg));
  }
}

// Shapes placed together as one group (text letters, hole-circle patterns)
// share the same Loch/Aufaddieren/Höhe/Tiefe/Seite settings - editing any one
// of them via the shape list applies the change to the whole group, so e.g.
// a bolt-circle pattern doesn't end up with some holes and some bosses.
function shapesInGroup(s) {
  return s.groupId != null ? shapes.filter(sh => sh.groupId === s.groupId) : [s];
}

function renderShapeList() {
  shapeListEl.innerHTML = '';
  if (shapes.length === 0) {
    shapeListEl.innerHTML = '<div class="empty">Noch keine Formen gezeichnet.</div>';
    return;
  }
  shapes.forEach((s, idx) => {
    const item = document.createElement('div');
    item.className = 'shape-item' + (s.isHole ? ' hole' : '') + (s.isAdditive ? ' additive' : '') + (selectedShapeIds.has(s.id) ? ' selected' : '');

    const row = document.createElement('div');
    row.className = 'shape-item-row';
    const label = document.createElement('span');
    label.textContent = `${idx + 1}. ${shapeLabel(s)}`;
    row.appendChild(label);

    const controls = document.createElement('span');

    const holeLabel = document.createElement('label');
    holeLabel.style.marginRight = '6px';
    holeLabel.style.fontSize = '11px';
    const holeCheckbox = document.createElement('input');
    holeCheckbox.type = 'checkbox';
    holeCheckbox.checked = !!s.isHole;
    holeCheckbox.addEventListener('change', () => {
      pushHistory();
      shapesInGroup(s).forEach(sh => {
        sh.isHole = holeCheckbox.checked;
        if (sh.isHole) sh.isAdditive = false;
      });
      onShapesChanged();
    });
    holeLabel.appendChild(holeCheckbox);
    holeLabel.appendChild(document.createTextNode(' Loch'));
    controls.appendChild(holeLabel);

    const addLabel = document.createElement('label');
    addLabel.style.marginRight = '6px';
    addLabel.style.fontSize = '11px';
    const addCheckbox = document.createElement('input');
    addCheckbox.type = 'checkbox';
    addCheckbox.checked = !!s.isAdditive;
    addCheckbox.addEventListener('change', () => {
      pushHistory();
      shapesInGroup(s).forEach(sh => {
        sh.isAdditive = addCheckbox.checked;
        if (sh.isAdditive) sh.isHole = false;
      });
      onShapesChanged();
    });
    addLabel.appendChild(addCheckbox);
    addLabel.appendChild(document.createTextNode(' Aufaddieren'));
    controls.appendChild(addLabel);

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Form löschen';
    delBtn.addEventListener('click', () => deleteShape(s.id));
    controls.appendChild(delBtn);

    row.appendChild(controls);
    row.addEventListener('click', (e) => {
      if (e.target === delBtn || e.target === holeCheckbox || e.target === addCheckbox) return;
      if (e.ctrlKey || e.metaKey) {
        if (selectedShapeIds.has(s.id)) selectedShapeIds.delete(s.id);
        else selectedShapeIds.add(s.id);
      } else {
        selectedShapeIds = new Set([s.id]);
      }
      renderShapeList();
      render();
    });
    item.appendChild(row);

    if (s.isAdditive) {
      const optRow = document.createElement('div');
      optRow.className = 'shape-item-options';

      const heightLabel = document.createElement('span');
      heightLabel.textContent = 'Höhe';
      optRow.appendChild(heightLabel);

      const heightInput = document.createElement('input');
      heightInput.type = 'number';
      heightInput.step = '0.1';
      heightInput.min = '0.1';
      heightInput.value = s.additiveHeight;
      heightInput.addEventListener('change', () => {
        const v = parseFloat(heightInput.value);
        pushHistory();
        if (!isNaN(v) && v > 0) shapesInGroup(s).forEach(sh => { sh.additiveHeight = v; });
        onShapesChanged();
      });
      optRow.appendChild(heightInput);

      const unitLabel = document.createElement('span');
      unitLabel.textContent = 'mm';
      optRow.appendChild(unitLabel);

      // "Oben"/"Unten" only means something for base-sketch additive shapes
      // (stacked onto the base extrusion's Z top/bottom); a face-feature boss
      // only ever grows outward along that face's own normal.
      if (!faceEditContext) {
        const btnTop = document.createElement('button');
        btnTop.type = 'button';
        btnTop.textContent = 'Oben';
        btnTop.className = 'side-btn' + (s.additiveSide === 'top' ? ' active' : '');

        const btnBottom = document.createElement('button');
        btnBottom.type = 'button';
        btnBottom.textContent = 'Unten';
        btnBottom.className = 'side-btn' + (s.additiveSide === 'bottom' ? ' active' : '');

        btnTop.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'top'; }); onShapesChanged(); });
        btnBottom.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'bottom'; }); onShapesChanged(); });

        optRow.appendChild(btnTop);
        optRow.appendChild(btnBottom);
      }
      item.appendChild(optRow);
    }

    if (s.isHole) {
      const depthRow = document.createElement('div');
      depthRow.className = 'shape-item-options';

      const depthLabel = document.createElement('span');
      depthLabel.textContent = 'Tiefe';
      depthRow.appendChild(depthLabel);

      const depthInput = document.createElement('input');
      depthInput.type = 'number';
      depthInput.step = '0.1';
      depthInput.min = '0.1';
      depthInput.value = s.holeDepth != null ? s.holeDepth : 5;
      depthInput.addEventListener('change', () => {
        const v = parseFloat(depthInput.value);
        pushHistory();
        if (!isNaN(v) && v > 0) shapesInGroup(s).forEach(sh => { sh.holeDepth = v; });
        onShapesChanged();
      });
      depthRow.appendChild(depthInput);

      const depthUnit = document.createElement('span');
      depthUnit.textContent = 'mm';
      depthRow.appendChild(depthUnit);

      // "Oben"/"Unten" only means something for base-sketch holes (cut from
      // the sketch plane Z=0 upward or downward); a face-feature pocket only
      // ever cuts inward along that face's own normal.
      if (!faceEditContext) {
        const btnTop = document.createElement('button');
        btnTop.type = 'button';
        btnTop.textContent = 'Oben';
        btnTop.className = 'side-btn' + (s.additiveSide === 'top' ? ' active' : '');

        const btnBottom = document.createElement('button');
        btnBottom.type = 'button';
        btnBottom.textContent = 'Unten';
        btnBottom.className = 'side-btn' + (s.additiveSide === 'bottom' ? ' active' : '');

        btnTop.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'top'; }); onShapesChanged(); });
        btnBottom.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'bottom'; }); onShapesChanged(); });

        depthRow.appendChild(btnTop);
        depthRow.appendChild(btnBottom);
      }

      item.appendChild(depthRow);
    }

    shapeListEl.appendChild(item);
  });
}

// ===========================================================================
// Toolbar buttons
// ===========================================================================

document.getElementById('tool-line').addEventListener('click', () => setTool('line'));
document.getElementById('tool-circle').addEventListener('click', () => setTool('circle'));
document.getElementById('tool-rect').addEventListener('click', () => setTool('rect'));
document.getElementById('tool-poly3').addEventListener('click', () => setTool('poly3'));
document.getElementById('tool-poly5').addEventListener('click', () => setTool('poly5'));
document.getElementById('tool-poly6').addEventListener('click', () => setTool('poly6'));
document.getElementById('tool-poly8').addEventListener('click', () => setTool('poly8'));
document.getElementById('tool-text').addEventListener('click', () => setTool('text'));
document.getElementById('tool-holecircle').addEventListener('click', () => setTool('holecircle'));
document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
document.getElementById('tool-dimension').addEventListener('click', () => setTool('dimension'));
document.getElementById('tool-origin').addEventListener('click', () => setTool('origin'));
document.getElementById('tool-point').addEventListener('click', () => setTool('point'));
document.getElementById('tool-edge').addEventListener('click', () => setTool('edge'));

btnUndo.addEventListener('click', () => {
  if (currentTool === 'line' && drawingPoints.length > 0) {
    drawingPoints.pop();
  } else if (currentTool === 'circle' && circleCenter) {
    circleCenter = null;
  } else if (history.length > 0) {
    shapes = history.pop();
    Array.from(selectedShapeIds).forEach(id => { if (!shapes.some(s => s.id === id)) selectedShapeIds.delete(id); });
    onShapesChanged();
  }
  render();
});

function doClearSketch() {
  if (shapes.length > 0 || faceFeatures.length > 0) markProjectDirty();
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  endDrag();
  faceSelectMode = false;
  faceEditContext = null;
  baseRollback = false;
  selectedShapeIds.clear();
  clearHoverHighlight();
  clearSelectedHighlight();

  shapes = [];
  history = [];
  faceFeatures = [];
  nextShapeId = 1;
  nextFeatureId = 1;

  if (extrudedGroup) {
    viewerScene.remove(extrudedGroup);
    extrudedGroup = null;
    meshVersion++;
    faceAdjacencyCache = null;
  }
  btnExport.disabled = true;
  extrudeStatusEl.textContent = '';

  renderShapeList();
  renderHistoryTree();
  updateFaceEditUI();
  render();
}

btnClear.addEventListener('click', () => {
  if (!projectDirty) { doClearSketch(); return; }
  const wantsSave = confirm(
    'Es gibt ungespeicherte Änderungen.\n\n' +
    'OK = zuerst als Projektdatei speichern, dann Skizze leeren\n' +
    'Abbrechen = nicht speichern (weiter zur Verwerfen-Abfrage)'
  );
  if (wantsSave) {
    btnSaveProject.click();
    doClearSketch();
    return;
  }
  if (confirm('Änderungen wirklich verwerfen und Skizze leeren?')) doClearSketch();
});

// Page refresh/close: browsers only allow a generic native "leave site?"
// prompt here (no custom Speichern/Verwerfen buttons are possible for
// security reasons) - the user can still cancel and use "Projekt speichern"
// manually before actually leaving.
window.addEventListener('beforeunload', (evt) => {
  if (!projectDirty) return;
  evt.preventDefault();
  evt.returnValue = '';
});


gridSizeInput.addEventListener('input', render);
gridOnInput.addEventListener('change', render);
angleStepInput.addEventListener('input', render);
angleOnInput.addEventListener('change', render);
rasterDistanceInput.addEventListener('change', render);

window.addEventListener('resize', resizeCanvas);

// ===========================================================================
// 3D viewer (Three.js)
// ===========================================================================

let viewerScene, viewerCamera, viewerRenderer, viewerControls;

function initViewer() {
  const container = document.getElementById('viewer');
  viewerScene = new THREE.Scene();
  viewerScene.background = new THREE.Color(0x202124);

  viewerCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  viewerCamera.up.set(0, 0, 1);
  viewerCamera.position.set(200, -260, 200);
  viewerCamera.lookAt(0, 0, 0);

  viewerRenderer = new THREE.WebGLRenderer({ antialias: true });
  container.appendChild(viewerRenderer.domElement);

  viewerControls = new THREE.OrbitControls(viewerCamera, viewerRenderer.domElement);
  viewerControls.enableDamping = true;

  // Face picking: only ever acts while faceSelectMode is on, and only on a
  // real click (small movement threshold) so orbit drags aren't misread as picks.
  viewerRenderer.domElement.addEventListener('pointerdown', onViewerPointerDown);
  viewerRenderer.domElement.addEventListener('pointerup', onViewerPointerUp);
  viewerRenderer.domElement.addEventListener('pointermove', onViewerPointerMove);

  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  viewerScene.add(ambient);
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.6);
  dir1.position.set(1, -1, 2);
  viewerScene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dir2.position.set(-1, 1, -1);
  viewerScene.add(dir2);

  const grid = new THREE.GridHelper(400, 40, 0x555555, 0x333333);
  grid.rotation.x = Math.PI / 2; // lay flat in the XY plane (Z stays up)
  viewerScene.add(grid);

  const axes = new THREE.AxesHelper(50);
  viewerScene.add(axes);

  resizeViewer();
  animate();
}

function resizeViewer() {
  const container = document.getElementById('viewer');
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  viewerCamera.aspect = w / h;
  viewerCamera.updateProjectionMatrix();
  viewerRenderer.setSize(w, h);
  viewerRenderer.setPixelRatio(window.devicePixelRatio || 1);
}

function animate() {
  requestAnimationFrame(animate);
  viewerControls.update();
  viewerRenderer.render(viewerScene, viewerCamera);
}

window.addEventListener('resize', resizeViewer);

// ===========================================================================
// Extrusion
// ===========================================================================

function shapePathPoints(shape) {
  if (shape.type === 'circle') {
    const pts = [];
    const segs = 64;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push({ x: shape.center.x + Math.cos(a) * shape.radius, y: shape.center.y + Math.sin(a) * shape.radius });
    }
    return pts;
  }
  return shape.points;
}

// Builds a replicad `Drawing` (2D profile) from a sketch shape. `flipY`
// matches the base sketch's Y-down world convention (mirrors the old
// toThreeShape's `-y`); face-feature shapes are already in the picked face's
// own (u,v) basis and don't flip - see shapeToDrawing call sites below.
function shapeToDrawing(shape, flipY) {
  const R = window.replicad;
  const sign = flipY ? -1 : 1;
  if (shape.type === 'circle') {
    return R.drawCircle(shape.radius).translate(shape.center.x, sign * shape.center.y);
  }
  const pts = getFilletedPoints(shape);
  let pen = R.draw([pts[0].x, sign * pts[0].y]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo([pts[i].x, sign * pts[i].y]);
  return pen.close();
}

// Converts a replicad Shape3D into a THREE.Mesh via its own BREP-aware
// tessellation (replaces the old CSG.toMesh() call). `faceGroups` maps
// triangle ranges back to real BREP face ids - stashed on the mesh for
// potential future use; the current face-picking still flood-fills by
// coplanarity (buildFaceAdjacency below), which works unchanged on this mesh too.
function replicadShapeToMesh(solid, material) {
  const { vertices, triangles, normals, faceGroups } = solid.mesh({ tolerance: 0.1, angularTolerance: 0.4 });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(triangles);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.faceGroups = faceGroups;
  return mesh;
}

// A prism-shaped Shape3D spanning [0, h] ('top') or [-h, 0] ('bottom') from
// the sketch plane (Z=0), overshooting slightly past Z=0 so a fuse/cut
// meeting exactly at the sketch plane isn't the classic ambiguous-coincident-
// face case (FEATURE_OVERSHOOT, see below).
function replicadSidedSolid(shape, h, side) {
  const drawing = shapeToDrawing(shape, true);
  const zOffset = side === 'bottom' ? FEATURE_OVERSHOOT : -FEATURE_OVERSHOOT;
  const direction = side === 'bottom' ? [0, 0, -1] : [0, 0, 1];
  const sketch = drawing.sketchOnPlane('XY', zOffset);
  return sketch.extrude(h + FEATURE_OVERSHOOT, { extrusionDirection: direction });
}

// Builds the base solid from `shapes`: every shape is either an "Aufaddieren"
// prism - growing from the sketch plane (Z=0) toward +Z ('top') or -Z
// ('bottom') by its own additiveHeight - or a "Loch" cutting prism removing
// material from Z=0 toward +Z or -Z by its own holeDepth, independently of
// whatever it geometrically overlaps. All of it is BREP-fused/cut (real
// OpenCascade booleans via replicad, not mesh-based CSG) into one solid
// (exactly the same idea as a face-feature's boss/pocket, just anchored to
// the sketch plane instead of a picked face - see applyFaceFeaturesSubset).
// Pure geometry construction, no scene/DOM side effects. Returns null if
// there's nothing to extrude.
function buildBaseGroup() {
  const additives = shapes.filter(s => s.isAdditive);
  const holes = shapes.filter(s => s.isHole);
  if (additives.length === 0) return null;

  const material = new THREE.MeshStandardMaterial({ color: 0x8fb8ff, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });

  let solid = null;
  additives.forEach(add => {
    const h = Math.max(0.01, parseFloat(add.additiveHeight) || 5);
    const piece = replicadSidedSolid(add, h, add.additiveSide);
    solid = solid ? solid.fuse(piece) : piece;
  });
  holes.forEach(hole => {
    const d = Math.max(0.01, parseFloat(hole.holeDepth) || 5);
    solid = solid.cut(replicadSidedSolid(hole, d, hole.additiveSide));
  });

  // The solid is deliberately left at the sketch's own coordinates (Z=0 at
  // the sketch plane, X/Y as drawn) instead of being re-centered on its
  // bounding box: re-centering here would shift the *entire* solid by a
  // different amount every time the base sketch was edited (any resize or
  // depth change moves the bounding-box center). Face features are fused/cut
  // at a fixed absolute position (see applyFaceFeaturesSubset) - if the base
  // moved out from under them on every rebuild, they'd never land in the
  // same place twice. frameCameraToGroup() below points the camera at the
  // model's actual center instead, so the view still looks centered without
  // moving the geometry itself.
  const group = new THREE.Group();
  group.add(replicadShapeToMesh(solid, material));

  return { group, material, solid };
}

function frameCameraToGroup(group) {
  const fullBox = new THREE.Box3().setFromObject(group);
  const size = fullBox.getSize(new THREE.Vector3());
  const center = fullBox.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.9 + 20;
  const dirVec = viewerCamera.position.clone().normalize();
  viewerCamera.position.copy(dirVec.multiplyScalar(radius * 2.2).add(center));
  viewerControls.target.copy(center);
  viewerControls.update();
}

// Rebuilds the full solid from scratch: base sketch -> (if any face features
// exist) BREP-fuse the base, then replay each face feature in creation order
// (boolean fuse/cut its boss/pocket geometry, at its original fixed
// position, into the running solid). Callable from the Extrudieren button
// directly, or via exitFaceEditMode() when that same button commits a
// face-edit sketch. Async because it awaits the WASM BREP kernel on first use.
async function rebuildSolid() {
  baseRollback = false;
  extrudeStatusEl.textContent = 'BREP-Kernel wird geladen…';
  btnExtrude.disabled = true;
  await window.ocReadyPromise;
  btnExtrude.disabled = false;
  extrudeStatusEl.textContent = '';

  if (!viewerScene) initViewer();

  const base = buildBaseGroup();
  if (!base) {
    extrudeStatusEl.textContent = 'Keine geschlossene Form zum Extrudieren vorhanden.';
    updateFaceEditUI();
    return;
  }

  if (extrudedGroup) {
    viewerScene.remove(extrudedGroup);
    extrudedGroup = null;
  }

  const warnings = [];

  // The base group is already one fully BREP-fused solid (see buildBaseGroup);
  // if face features exist, replay them on top of it.
  const finalGroup = faceFeatures.length === 0 ? base.group : applyFaceFeatures(base.solid, base.material, warnings);

  viewerScene.add(finalGroup);
  extrudedGroup = finalGroup;
  meshVersion++;
  faceAdjacencyCache = null;

  frameCameraToGroup(finalGroup);

  extrudeStatusEl.textContent = warnings.join(' ');
  btnExport.disabled = false;
  updateFaceEditUI();
}

btnExtrude.addEventListener('click', () => {
  if (faceEditContext) exitFaceEditMode(true);
  else rebuildSolid();
});

// ===========================================================================
// Face editing: pick a planar face on the 3D model, sketch on it, and
// add/cut real (CSG boolean) geometry along its normal.
// ===========================================================================

// ---- 2D/3D helpers for face picking ------------------------------------------

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Area-weighted polygon centroid (correct for simple, non-self-intersecting
// polygons); falls back to a plain vertex average for degenerate/zero-area input.
function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    const sum = pts.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / n, y: sum.y / n };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

// Builds a stable 2D (u,v) basis on a plane given its world-space normal and
// an origin point on it. For top/bottom faces (normal ~ world Z) falls back
// to world X as the reference axis since up×normal would be degenerate there.
function buildFaceBasis(normal, origin) {
  const n = normal.clone().normalize();
  const worldUp = new THREE.Vector3(0, 0, 1);
  const uAxis = Math.abs(n.dot(worldUp)) > 0.999
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3().crossVectors(worldUp, n).normalize();
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();
  return { origin: origin.clone(), normal: n, uAxis, vAxis };
}

function worldToUV(p, basis) {
  const rel = new THREE.Vector3().subVectors(p, basis.origin);
  return { x: rel.dot(basis.uAxis), y: rel.dot(basis.vAxis) };
}

// ---- mesh adjacency + coplanar flood-fill + boundary tracing ----------------

// Builds a per-triangle adjacency structure for a mesh's geometry, keyed by
// *rounded world-space vertex position* rather than raw attribute index, so
// it works uniformly whether the geometry is non-indexed with exact shared
// coordinates (plain ExtrudeGeometry, pre-CSG) or indexed with welded
// coordinates (CSG.toMesh output).
function buildFaceAdjacency(mesh) {
  mesh.updateMatrixWorld(true);
  const geometry = mesh.geometry;
  const pos = geometry.attributes.position;
  const index = geometry.index;
  const triCount = index ? index.count / 3 : pos.count / 3;
  const attrIndex = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  // Same tolerance as CSG.js's vertex welding (js/csg.js WELD_PRECISION) - both
  // need to agree on "same point" or post-CSG geometry silently fails to weld
  // back into contiguous, pickable faces.
  const WELD_PRECISION = 50;
  const posKey = (i) => Math.round(pos.getX(i) * WELD_PRECISION) + ',' + Math.round(pos.getY(i) * WELD_PRECISION) + ',' + Math.round(pos.getZ(i) * WELD_PRECISION);

  const triangles = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = attrIndex(t, 0), i1 = attrIndex(t, 1), i2 = attrIndex(t, 2);
    const a = new THREE.Vector3().fromBufferAttribute(pos, i0);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i2);
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const len = normal.length();
    if (len < 1e-12) { triangles.push(null); continue; } // degenerate sliver, keep index alignment
    normal.divideScalar(len);
    triangles.push({ verts: [i0, i1, i2], normal, keys: [posKey(i0), posKey(i1), posKey(i2)] });
  }

  return { triangles, pos, matrixWorld: mesh.matrixWorld.clone() };
}

function getOrBuildAdjacency(mesh) {
  if (!faceAdjacencyCache || faceAdjacencyCache.version !== meshVersion) {
    faceAdjacencyCache = { version: meshVersion, byObject: new Map() };
  }
  let adj = faceAdjacencyCache.byObject.get(mesh);
  if (!adj) {
    adj = buildFaceAdjacency(mesh);
    faceAdjacencyCache.byObject.set(mesh, adj);
  }
  return adj;
}

const FACE_NORMAL_TOL = 0.999; // dot product
const FACE_DIST_TOL = 1e-3;    // mm, world space, for interactive flood-fill

// Collects every triangle of the mesh coplanar with `seedTri` (matching
// normal direction and plane distance within tolerance). Grouping is by pure
// plane membership rather than edge-connectivity: BSP CSG splits with
// infinite planes, so a union/subtract elsewhere on the solid routinely
// fragments a distant, otherwise-untouched coplanar face into pieces that
// don't all share exact matching edges with their neighbors (T-junctions) -
// edge-adjacency flood-fill would silently stop at the first crack and only
// return a small piece of the real face. The (rare) tradeoff is that two
// genuinely disconnected faces that happen to share the same plane equation
// get merged into one candidate region; traceBoundaryLoops still produces
// their separate boundary loops correctly, and callers pick the largest one.
// Returns {triIndices, normal (world space), planeD} or null if the seed is degenerate.
function floodFillCoplanarRegion(adj, seedTri, normalTol, distTol) {
  const seed = adj.triangles[seedTri];
  if (!seed) return null;
  const matrix = adj.matrixWorld;
  const worldNormal = seed.normal.clone().transformDirection(matrix).normalize();
  const seedPoint = new THREE.Vector3().fromBufferAttribute(adj.pos, seed.verts[0]).applyMatrix4(matrix);
  const planeD = worldNormal.dot(seedPoint);
  const nTol = normalTol != null ? normalTol : FACE_NORMAL_TOL;
  const dTol = distTol != null ? distTol : FACE_DIST_TOL;

  const triIndices = [];
  for (let ti = 0; ti < adj.triangles.length; ti++) {
    const tri = adj.triangles[ti];
    if (!tri) continue;
    const tn = tri.normal.clone().transformDirection(matrix).normalize();
    if (tn.dot(worldNormal) < nTol) continue;
    const p = new THREE.Vector3().fromBufferAttribute(adj.pos, tri.verts[0]).applyMatrix4(matrix);
    if (Math.abs(worldNormal.dot(p) - planeD) > dTol) continue;
    triIndices.push(ti);
  }
  return { triIndices, normal: worldNormal, planeD };
}

// Traces the boundary of a coplanar triangle region into one or more closed
// loops of world-space points. BSP CSG splits with infinite planes, so a
// union/subtract elsewhere on the solid can slice a distant, otherwise-untouched
// coplanar face into many fragments that don't all share exact matching edges
// with their neighbors (a T-junction: one side has a single long edge, the
// other has that same span broken into several shorter collinear edges). A
// plain "edges used by exactly one triangle" count misclassifies every piece
// of such a crack as boundary. To fix this, every triangle edge in the region
// is first subdivided at any other region vertex that lies exactly on it, so
// both sides of a crack end up with matching sub-edges that correctly cancel
// out as interior before the remaining (genuinely boundary) sub-edges are
// chained into loops.
function traceBoundaryLoops(adj, triIndices) {
  const vertexByKey = new Map(); // posKey -> world Vector3
  const rawEdges = []; // {aKey, bKey}, one entry per triangle edge (both directions across a shared edge)
  const posOf = (idx) => new THREE.Vector3().fromBufferAttribute(adj.pos, idx).applyMatrix4(adj.matrixWorld);

  triIndices.forEach((ti) => {
    const tri = adj.triangles[ti];
    for (let e = 0; e < 3; e++) {
      const va = tri.verts[e], vb = tri.verts[(e + 1) % 3];
      const ka = tri.keys[e], kb = tri.keys[(e + 1) % 3];
      if (!vertexByKey.has(ka)) vertexByKey.set(ka, posOf(va));
      if (!vertexByKey.has(kb)) vertexByKey.set(kb, posOf(vb));
      rawEdges.push({ aKey: ka, bKey: kb });
    }
  });

  const allVerts = Array.from(vertexByKey.entries());
  const TJ_EPS = 1e-3; // mm, off-line tolerance for "this vertex sits on that edge"

  const subEdgeCount = new Map(); // 'key|key' -> occurrence count after subdivision
  const subEdgeList = []; // {aKey, bKey, ukey}, in original winding order

  rawEdges.forEach(({ aKey, bKey }) => {
    const a = vertexByKey.get(aKey), b = vertexByKey.get(bKey);
    const ab = new THREE.Vector3().subVectors(b, a);
    const lenSq = ab.lengthSq();
    const onSegment = [];
    if (lenSq > 1e-12) {
      allVerts.forEach(([key, p]) => {
        if (key === aKey || key === bKey) return;
        const t = new THREE.Vector3().subVectors(p, a).dot(ab) / lenSq;
        if (t <= 1e-6 || t >= 1 - 1e-6) return; // not strictly between the endpoints
        if (a.clone().addScaledVector(ab, t).distanceTo(p) > TJ_EPS) return; // not on the line
        onSegment.push({ key, t });
      });
    }
    onSegment.sort((x, y) => x.t - y.t);
    const chain = [aKey, ...onSegment.map((s) => s.key), bKey];
    for (let i = 0; i < chain.length - 1; i++) {
      const k1 = chain[i], k2 = chain[i + 1];
      const ukey = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
      subEdgeCount.set(ukey, (subEdgeCount.get(ukey) || 0) + 1);
      subEdgeList.push({ aKey: k1, bKey: k2, ukey });
    }
  });

  const boundary = subEdgeList.filter((e) => subEdgeCount.get(e.ukey) === 1);

  const byStartKey = new Map();
  boundary.forEach((e) => {
    if (!byStartKey.has(e.aKey)) byStartKey.set(e.aKey, []);
    byStartKey.get(e.aKey).push(e);
  });

  // At a fork (more than one unused candidate continues from this point - can
  // happen when a leftover CSG sliver duplicates part of the real boundary a
  // fraction of a mm away and happens to touch it at a welded vertex), prefer
  // whichever candidate continues most nearly straight ahead. A genuine
  // rectangle/polygon corner turns by some moderate angle; ducking into a
  // spurious duplicate-edge spike and back requires a much sharper turn, so
  // "least turning" reliably keeps the trace on the real boundary.
  function pickNext(prevPoint, curPoint, candidates) {
    if (candidates.length <= 1) return candidates[0] || null;
    const inDir = new THREE.Vector3().subVectors(curPoint, prevPoint).normalize();
    let best = candidates[0], bestDot = -Infinity;
    candidates.forEach((c) => {
      const outDir = new THREE.Vector3().subVectors(vertexByKey.get(c.bKey), curPoint).normalize();
      const d = inDir.dot(outDir);
      if (d > bestDot) { bestDot = d; best = c; }
    });
    return best;
  }

  const used = new Set();
  const loops = [];
  boundary.forEach((start) => {
    if (used.has(start)) return;
    const loop = [];
    let current = start;
    let guard = 0;
    while (current && !used.has(current) && guard <= boundary.length) {
      used.add(current);
      const edgeStart = vertexByKey.get(current.aKey);
      const edgeEnd = vertexByKey.get(current.bKey);
      loop.push(edgeStart);
      const candidates = (byStartKey.get(current.bKey) || []).filter((c) => !used.has(c));
      current = pickNext(edgeStart, edgeEnd, candidates);
      guard++;
    }
    if (loop.length >= 3) loops.push(loop);
  });
  return loops; // array of loops, each an array of world-space THREE.Vector3 points
}

// From a set of world-space boundary loops, builds the (basis, outer-loop-uv,
// inner-loops-uv) result: origin = outer loop's world centroid, outer loop =
// the one with the largest projected area.
function buildFaceRegionResult(adj, region, loops) {
  const worldLoops = loops;
  const provisionalBasis = buildFaceBasis(region.normal, worldLoops[0][0]);
  const provisionalUV = worldLoops.map((loop) => loop.map((p) => worldToUV(p, provisionalBasis)));
  const areas = provisionalUV.map((l) => Math.abs(polygonArea(l)));
  let outerIdx = 0;
  for (let i = 1; i < areas.length; i++) if (areas[i] > areas[outerIdx]) outerIdx = i;

  const centroidWorld = worldLoops[outerIdx].reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / worldLoops[outerIdx].length);
  const basis = buildFaceBasis(region.normal, centroidWorld);
  const boundaryLoopUV = worldLoops[outerIdx].map((p) => worldToUV(p, basis));
  const innerLoopsUV = worldLoops.filter((_, i) => i !== outerIdx).map((loop) => loop.map((p) => worldToUV(p, basis)));

  return { basis, boundaryLoopUV, innerLoopsUV, triIndices: region.triIndices };
}

function getFaceRegionForHit(hit) {
  const adj = getOrBuildAdjacency(hit.object);
  const region = floodFillCoplanarRegion(adj, hit.faceIndex);
  if (!region) return null;
  const loops = traceBoundaryLoops(adj, region.triIndices);
  if (loops.length === 0) return null;
  return buildFaceRegionResult(adj, region, loops);
}

// ---- face-feature -> 3D geometry --------------------------------------------

// Builds a replicad `Plane` from a picked-face basis (as produced by
// buildFaceBasis: THREE.Vector3 origin/normal/uAxis/vAxis), shifted by
// `offsetAlongNormal` along that plane's own normal - the BREP equivalent of
// the old extrudeFaceShape's `matrix.setPosition(...along normal...)`.
function replicadPlaneFromBasis(basis, offsetAlongNormal) {
  const o = basis.origin.clone().addScaledVector(basis.normal, offsetAlongNormal || 0);
  return new window.replicad.Plane(
    [o.x, o.y, o.z],
    [basis.uAxis.x, basis.uAxis.y, basis.uAxis.z],
    [basis.normal.x, basis.normal.y, basis.normal.z]
  );
}

// Builds a boss/pocket Shape3D on a picked face's basis, spanning from
// `alongNormalFrom` to `alongNormalTo` (signed offsets from the face plane
// along its normal) - the BREP equivalent of the old extrudeFaceShape.
function extrudeFaceShape(shape, basis, alongNormalFrom, alongNormalTo) {
  const drawing = shapeToDrawing(shape, false);
  const plane = replicadPlaneFromBasis(basis, alongNormalFrom);
  const depth = alongNormalTo - alongNormalFrom;
  return drawing.sketchOnPlane(plane).extrude(depth);
}

// A small overshoot so boss/pocket solids slightly overlap the existing
// solid's surface instead of meeting it exactly - avoids the classic BSP-CSG
// failure mode where an exactly-coincident cut/add plane gets misclassified.
// (OpenCascade's exact BREP booleans are less prone to this than the old
// mesh-based csg.js, but coincident faces are still a degenerate case worth
// avoiding on principle, so the overshoot stays.)
const FEATURE_OVERSHOOT = 0.05; // mm

// Starting from `baseSolid` (the already-built base sketch, a replicad
// Shape3D), replays each given face feature in creation order: extrude each
// of its shapes (additive -> fuse boss, hole -> cut pocket) along the
// feature's stored basis - the exact plane it was originally sketched on -
// and fold it into the solid. `featureList` is a prefix of (or the full)
// `faceFeatures`, so this also powers the temporary "rolled back" preview
// shown while re-editing an earlier feature (see showRollbackPreview).
//
// Deliberately does NOT try to re-locate the feature's face if the base (or
// an earlier feature) has since changed shape: the boss/pocket stays fixed
// at its original absolute position and orientation, cut/fused into whatever
// the solid now is there - it does not follow the face around. That's a
// user-facing choice, not just simplicity: chasing a "best guess" match
// after a shape edit can silently land a feature in the wrong place, which
// is worse than it staying put and looking obviously wrong (or being a no-op
// if the solid no longer reaches that point in space).
function applyFaceFeaturesSubset(baseSolid, material, featureList, warnings) {
  let solid = baseSolid;

  featureList.forEach((feature, idx) => {
    const basis = feature.basis;
    feature.shapes.forEach((s) => {
      if (!s.isAdditive && !s.isHole) return;
      try {
        if (s.isAdditive) {
          const h = Math.max(0.01, parseFloat(s.additiveHeight) || 5);
          solid = solid.fuse(extrudeFaceShape(s, basis, -FEATURE_OVERSHOOT, h));
        } else {
          const d = Math.max(0.01, parseFloat(s.holeDepth) || 5);
          solid = solid.cut(extrudeFaceShape(s, basis, -d, FEATURE_OVERSHOOT));
        }
      } catch (err) {
        warnings.push(`Feature #${idx + 1} konnte nicht angewendet werden, übersprungen.`);
      }
    });
  });

  const group = new THREE.Group();
  group.add(replicadShapeToMesh(solid, material));
  return group;
}

function applyFaceFeatures(baseSolid, material, warnings) {
  return applyFaceFeaturesSubset(baseSolid, material, faceFeatures, warnings);
}

// Shows a temporary preview of the solid as it existed right before a given
// point in the timeline (base-only, or base + a prefix of faceFeatures),
// while the user edits an earlier sketch - so the 3D view doesn't lie about
// later features that depend on geometry currently being changed. Replaced
// by a full rebuildSolid() once editing ends (both Extrudieren and Abbrechen),
// which reapplies everything up to the end of the timeline again.
async function showRollbackPreview(featureCount) {
  if (extrudedGroup) {
    viewerScene.remove(extrudedGroup);
    extrudedGroup = null;
  }
  await window.ocReadyPromise;
  const base = buildBaseGroup();
  btnExport.disabled = true;
  if (!base) {
    extrudeStatusEl.textContent = 'Keine geschlossene Form zum Extrudieren vorhanden.';
    return;
  }
  const warnings = [];
  const group = featureCount === 0 ? base.group : applyFaceFeaturesSubset(base.solid, base.material, faceFeatures.slice(0, featureCount), warnings);
  viewerScene.add(group);
  extrudedGroup = group;
  meshVersion++;
  faceAdjacencyCache = null;
  extrudeStatusEl.textContent = warnings.join(' ');
}

// ---- picking: raycast + hover/selection highlight ---------------------------

const faceRaycaster = new THREE.Raycaster();
let viewerPointerDown = null;

const HIGHLIGHT_MATERIAL_HOVER = new THREE.MeshBasicMaterial({ color: 0x4a7dfc, transparent: true, opacity: 0.35, depthTest: true, side: THREE.DoubleSide });
const HIGHLIGHT_MATERIAL_SELECTED = new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.35, depthTest: true, side: THREE.DoubleSide });

function raycastViewer(evt) {
  if (!extrudedGroup) return null;
  const rect = viewerRenderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((evt.clientX - rect.left) / rect.width) * 2 - 1,
    -((evt.clientY - rect.top) / rect.height) * 2 + 1
  );
  faceRaycaster.setFromCamera(ndc, viewerCamera);
  const intersects = faceRaycaster.intersectObject(extrudedGroup, true);
  return intersects.length ? intersects[0] : null;
}

function buildHighlightGeometry(adj, triIndices, normal) {
  const positions = [];
  triIndices.forEach((ti) => {
    const tri = adj.triangles[ti];
    tri.verts.forEach((vi) => {
      const p = new THREE.Vector3().fromBufferAttribute(adj.pos, vi).applyMatrix4(adj.matrixWorld);
      p.addScaledVector(normal, 0.3); // lift slightly off the surface to avoid z-fighting
      positions.push(p.x, p.y, p.z);
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function clearHoverHighlight() {
  if (hoverFaceHighlight) {
    viewerScene.remove(hoverFaceHighlight);
    hoverFaceHighlight.geometry.dispose();
    hoverFaceHighlight = null;
  }
}

function clearSelectedHighlight() {
  if (selectedFaceHighlight) {
    viewerScene.remove(selectedFaceHighlight);
    selectedFaceHighlight.geometry.dispose();
    selectedFaceHighlight = null;
  }
}

function onViewerPointerDown(evt) {
  viewerPointerDown = { x: evt.clientX, y: evt.clientY };
}

function onViewerPointerUp(evt) {
  if (!viewerPointerDown) return;
  const moved = Math.hypot(evt.clientX - viewerPointerDown.x, evt.clientY - viewerPointerDown.y);
  viewerPointerDown = null;
  if (moved > 5) return; // an orbit drag, not a pick click
  if (!faceSelectMode) return;
  const hit = raycastViewer(evt);
  if (!hit) return;
  const result = getFaceRegionForHit(hit);
  if (!result) return;
  faceSelectMode = false;
  clearHoverHighlight();
  const adj = getOrBuildAdjacency(hit.object);
  clearSelectedHighlight();
  selectedFaceHighlight = new THREE.Mesh(buildHighlightGeometry(adj, result.triIndices, result.basis.normal), HIGHLIGHT_MATERIAL_SELECTED);
  viewerScene.add(selectedFaceHighlight);
  enterFaceEditMode(result);
}

function onViewerPointerMove(evt) {
  if (!faceSelectMode) return;
  const hit = raycastViewer(evt);
  if (!hit) { clearHoverHighlight(); return; }
  const adj = getOrBuildAdjacency(hit.object);
  const region = floodFillCoplanarRegion(adj, hit.faceIndex);
  if (!region) { clearHoverHighlight(); return; }
  clearHoverHighlight();
  hoverFaceHighlight = new THREE.Mesh(buildHighlightGeometry(adj, region.triIndices, region.normal), HIGHLIGHT_MATERIAL_HOVER);
  viewerScene.add(hoverFaceHighlight);
}

// ---- face-edit mode: state, UI wiring ---------------------------------------

// Fits the 2D view to a face's (u,v) boundary loop so the user doesn't land
// on an empty canvas - face-local coordinates are rarely near the base
// sketch's (0,0).
function fitViewToLoop(loop) {
  if (!loop || loop.length === 0) { viewScale = 1; viewOffset = { x: 0, y: 0 }; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  loop.forEach((p) => {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  });
  const w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
  const bw = Math.max(1e-3, maxX - minX), bh = Math.max(1e-3, maxY - minY);
  const margin = 0.75;
  const scale = Math.min((w * margin) / bw, (h * margin) / bh);
  viewScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  viewOffset = { x: w / 2 - cx * viewScale, y: h / 2 - cy * viewScale };
}

// True while enterFaceEditMode() is (re-)locating an existing feature's face
// on the rolled-back solid - guards against a second click re-entering
// before faceEditContext is set (see enterFaceEditMode).
// Swaps the module-level `shapes`/`history` to a face feature's own sketch
// (new, empty for a brand-new feature, or a previously-saved one when
// re-editing), stashing the base sketch to restore later. All in-progress
// drawing/editor state is force-reset rather than preserved across the
// switch, matching the existing pattern setTool() already uses for tool changes.
//
// Always shows the feature's originally stored basis/boundaryLoopUV, even if
// the base sketch has since changed shape - features stay fixed at their
// original position rather than trying to follow a moved/resized face (see
// applyFaceFeaturesSubset), so that stored outline is still the accurate
// reference for where this feature's geometry actually sits.
function enterFaceEditMode(pick) {
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  endDrag();
  selectedShapeIds.clear();
  baseRollback = false;

  const existingIdx = pick.featureId ? faceFeatures.findIndex((f) => f.id === pick.featureId) : -1;
  const existing = existingIdx >= 0 ? faceFeatures[existingIdx] : null;

  faceEditContext = {
    featureId: pick.featureId || null,
    basis: pick.basis,
    boundaryLoopUV: pick.boundaryLoopUV,
    innerLoopsUV: pick.innerLoopsUV || [],
    baseShapes: shapes,
    baseHistory: history,
  };

  // Re-editing an existing feature: temporarily roll the 3D view back to how
  // the model looked right before this feature was applied (base + every
  // earlier feature, but not this one or any later one). Must run before
  // `shapes` is swapped to the feature's own sketch below, since it rebuilds
  // from the base sketch via the global `shapes`/buildBaseGroup().
  if (existingIdx >= 0) showRollbackPreview(existingIdx);

  // Deep-clone so in-place edits (dragging a point, changing a length, adding
  // a shape) don't leak into the stored feature until "Extrudieren" actually
  // commits `shapes` back onto it - otherwise "Abbrechen" couldn't undo them.
  shapes = existing ? JSON.parse(JSON.stringify(existing.shapes)) : [];
  history = [];

  fitViewToLoop(pick.boundaryLoopUV);
  renderShapeList();
  updateFaceEditUI();
  render();
}

function exitFaceEditMode(commit) {
  if (!faceEditContext) return;
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  endDrag();
  selectedShapeIds.clear();

  const ctx = faceEditContext;
  if (commit) {
    if (ctx.featureId) {
      const f = faceFeatures.find((x) => x.id === ctx.featureId);
      f.shapes = shapes;
    } else {
      faceFeatures.push({
        id: nextFeatureId++,
        basis: ctx.basis,
        boundaryLoopUV: ctx.boundaryLoopUV,
        innerLoopsUV: ctx.innerLoopsUV,
        shapes: shapes,
      });
    }
    markProjectDirty();
  }

  shapes = ctx.baseShapes;
  history = ctx.baseHistory;
  faceEditContext = null;
  clearSelectedHighlight();
  clearHoverHighlight();
  renderShapeList();

  // Whether committed or cancelled, leaving edit mode always jumps back to
  // the end of the timeline: rebuild from the base sketch through every
  // feature (using the just-saved shapes when committed, the untouched
  // feature otherwise), replacing the temporary rollback preview.
  rebuildSolid();
  render();
}

function reopenFaceFeature(id) {
  if (faceEditContext || faceSelectMode) return;
  const f = faceFeatures.find((x) => x.id === id);
  if (!f) return;
  enterFaceEditMode({ featureId: f.id, basis: f.basis, boundaryLoopUV: f.boundaryLoopUV, innerLoopsUV: f.innerLoopsUV });
}

function deleteFaceFeature(id) {
  if (faceEditContext || faceSelectMode) return;
  faceFeatures = faceFeatures.filter((f) => f.id !== id);
  markProjectDirty();
  rebuildSolid();
}

// ===========================================================================
// History tree (left panel): base sketch + every face-sketch feature, in
// creation order. Clicking an earlier entry temporarily rolls the model back
// to that point (see showRollbackPreview) so it can be re-edited; applying or
// cancelling that edit always jumps back to the end of the timeline again
// (rebuildSolid replays the full feature list).
// ===========================================================================

function timelineEntries() {
  const entries = [{ type: 'base', label: 'Skizze 1 (Basis)' }];
  faceFeatures.forEach((f, i) => entries.push({ type: 'feature', feature: f, label: `Skizze ${i + 2}` }));
  return entries;
}

// Index into timelineEntries() of the entry currently being (re-)edited, or
// null when the model reflects the full, un-rolled-back end of the history.
function currentTimelineIndex() {
  if (baseRollback) return 0;
  if (faceEditContext) {
    if (faceEditContext.featureId) {
      const i = faceFeatures.findIndex((f) => f.id === faceEditContext.featureId);
      return i >= 0 ? i + 1 : null;
    }
    return faceFeatures.length + 1; // brand-new feature, sketched beyond the current end - nothing to suppress
  }
  return null;
}

function goToTimelineEntry(idx) {
  if (faceEditContext || faceSelectMode) return;
  const entry = timelineEntries()[idx];
  if (!entry) return;
  if (entry.type === 'base') {
    baseRollback = true;
    if (extrudedGroup) {
      viewerScene.remove(extrudedGroup);
      extrudedGroup = null;
      meshVersion++;
      faceAdjacencyCache = null;
    }
    btnExport.disabled = true;
    extrudeStatusEl.textContent = 'Zurückgerollt zur Basis-Skizze. „Extrudieren“ klicken, um bis zum Ende des Verlaufs zu aktualisieren.';
    selectedShapeIds.clear();
    renderShapeList();
    updateFaceEditUI();
    render();
  } else {
    baseRollback = false;
    reopenFaceFeature(entry.feature.id);
  }
}

// Cancels a base rollback that hasn't been re-extruded yet, restoring the
// full end-of-history model without requiring any sketch changes.
function jumpToEndOfHistory() {
  if (faceEditContext || faceSelectMode || !baseRollback) return;
  rebuildSolid();
}

function renderHistoryTree() {
  const el = document.getElementById('history-tree');
  if (!el) return;
  el.innerHTML = '';
  const entries = timelineEntries();
  const curIdx = currentTimelineIndex();
  const busy = !!faceEditContext || faceSelectMode;

  entries.forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (curIdx !== null) {
      if (idx === curIdx) item.classList.add('editing');
      else if (idx > curIdx) item.classList.add('suppressed');
    }

    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.textContent = entry.type === 'base' ? '⬛' : '🔲';
    item.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = entry.label;
    item.title = entry.type === 'base' ? 'Basis-Skizze bearbeiten' : 'Diese Flächen-Skizze bearbeiten';
    item.appendChild(label);

    if (entry.type === 'feature') {
      const delBtn = document.createElement('button');
      delBtn.className = 'history-del-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Feature löschen';
      delBtn.disabled = busy;
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteFaceFeature(entry.feature.id); });
      item.appendChild(delBtn);
    }

    if (!busy) item.addEventListener('click', () => goToTimelineEntry(idx));
    else item.style.cursor = 'default';

    el.appendChild(item);
  });

  const endMarker = document.createElement('div');
  endMarker.className = 'history-end' + (curIdx === null ? ' active' : '');
  endMarker.textContent = curIdx === null ? '● Ende (aktuell)' : '○ Ende';
  if (!busy && baseRollback) {
    endMarker.title = 'Zum Ende des Verlaufs springen (Rollback verwerfen)';
    endMarker.addEventListener('click', jumpToEndOfHistory);
  } else {
    endMarker.style.cursor = 'default';
  }
  el.appendChild(endMarker);

  if (busy) {
    const hint = document.createElement('div');
    hint.className = 'history-hint';
    hint.textContent = 'Erst „Extrudieren“ oder „Abbrechen“, um eine andere Skizze zu wählen.';
    el.appendChild(hint);
  }
}

function updateFaceEditUI() {
  const selectHint = document.getElementById('face-select-hint');
  const editControls = document.getElementById('face-edit-controls');
  const title = document.getElementById('sketch-pane-title');

  if (selectHint) selectHint.style.display = faceSelectMode ? 'flex' : 'none';
  if (editControls) editControls.style.display = faceEditContext ? 'flex' : 'none';
  btnEditFace.disabled = !extrudedGroup || faceSelectMode || !!faceEditContext;

  if (title) {
    if (faceEditContext) {
      const idx = faceEditContext.featureId ? faceFeatures.findIndex((f) => f.id === faceEditContext.featureId) : faceFeatures.length;
      title.textContent = `Flächen-Skizze — Skizze ${idx + 2} — bearbeiten und „Extrudieren“ klicken`;
    } else if (baseRollback) {
      title.textContent = 'Basis-Skizze (zurückgerollt) — bearbeiten und „Extrudieren“ klicken';
    } else {
      title.textContent = '2D Skizze (Klicken zum Zeichnen)';
    }
  }
  renderHistoryTree();
}

const btnEditFace = document.getElementById('btn-edit-face');
const btnCancelFaceSelect = document.getElementById('btn-cancel-face-select');
const btnCancelFaceEdit = document.getElementById('btn-cancel-face-edit');

btnEditFace.addEventListener('click', () => {
  if (!extrudedGroup || faceEditContext) return;
  faceSelectMode = true;
  updateFaceEditUI();
});

btnCancelFaceSelect.addEventListener('click', () => {
  faceSelectMode = false;
  clearHoverHighlight();
  updateFaceEditUI();
});

btnCancelFaceEdit.addEventListener('click', () => exitFaceEditMode(false));

// ===========================================================================
// Project save / load (editable .mrcad project file, separate from STL export)
// ===========================================================================

const PROJECT_FILE_VERSION = 1;

function vec3ToPlain(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function plainToVec3(p) {
  return new THREE.Vector3(p.x, p.y, p.z);
}

// Captures everything rebuildSolid() needs to reconstruct the model: the base
// sketch (each shape carries its own additiveHeight/holeDepth) and every
// face-sketch feature (with its Vector3 basis flattened to plain {x,y,z} so
// it round-trips through JSON).
function serializeProject() {
  return {
    fileType: 'mrcad-project',
    version: PROJECT_FILE_VERSION,
    nextShapeId,
    nextFeatureId,
    shapes,
    faceFeatures: faceFeatures.map(f => ({
      id: f.id,
      basis: {
        origin: vec3ToPlain(f.basis.origin),
        normal: vec3ToPlain(f.basis.normal),
        uAxis: vec3ToPlain(f.basis.uAxis),
        vAxis: vec3ToPlain(f.basis.vAxis),
      },
      boundaryLoopUV: f.boundaryLoopUV,
      innerLoopsUV: f.innerLoopsUV,
      shapes: f.shapes,
    })),
  };
}

btnSaveProject.addEventListener('click', () => {
  const data = JSON.stringify(serializeProject(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modell.mrcad';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  projectDirty = false;
});

btnLoadProject.addEventListener('click', () => {
  if (faceEditContext || faceSelectMode) {
    alert('Bitte erst die aktuelle Flächen-Bearbeitung übernehmen oder abbrechen.');
    return;
  }
  loadProjectInput.value = '';
  loadProjectInput.click();
});

loadProjectInput.addEventListener('change', () => {
  const file = loadProjectInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert('Datei ist keine gültige MR-CAD Projektdatei (kein JSON).');
      return;
    }
    if (!data || data.fileType !== 'mrcad-project' || !Array.isArray(data.shapes)) {
      alert('Datei ist keine gültige MR-CAD Projektdatei.');
      return;
    }
    loadProject(data);
  };
  reader.readAsText(file);
});

// Restores full editing state (base sketch, extrusion depth, face features)
// from a parsed project file, then rebuilds the 3D model.
function loadProject(data) {
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  endDrag();
  faceSelectMode = false;
  faceEditContext = null;
  baseRollback = false;
  selectedShapeIds.clear();
  panState = null;
  clearHoverHighlight();
  clearSelectedHighlight();

  shapes = data.shapes;
  history = [];

  // Migrate project files saved before per-shape height/depth existed: back
  // then, a plain (neither isHole nor isAdditive) shape extruded to one
  // shared depth - now every shape needs its own additiveHeight, so give
  // those old plain shapes the file's old shared depth as a starting point.
  const legacyDepth = data.extrudeDepth || 10;
  shapes.forEach(s => {
    if (!s.isHole && !s.isAdditive) {
      s.isAdditive = true;
      if (s.additiveHeight == null) s.additiveHeight = legacyDepth;
      if (s.additiveSide == null) s.additiveSide = 'top';
    }
  });

  faceFeatures = (data.faceFeatures || []).map(f => ({
    id: f.id,
    basis: {
      origin: plainToVec3(f.basis.origin),
      normal: plainToVec3(f.basis.normal),
      uAxis: plainToVec3(f.basis.uAxis),
      vAxis: plainToVec3(f.basis.vAxis),
    },
    boundaryLoopUV: f.boundaryLoopUV,
    innerLoopsUV: f.innerLoopsUV || [],
    shapes: f.shapes,
  }));

  const maxShapeId = shapes.reduce((m, s) => Math.max(m, s.id || 0), 0);
  const maxFeatureId = faceFeatures.reduce((m, f) => Math.max(m, f.id || 0), 0);
  nextShapeId = data.nextShapeId || (maxShapeId + 1);
  nextFeatureId = data.nextFeatureId || (maxFeatureId + 1);

  projectDirty = false;
  markDirty();
  renderShapeList();
  renderHistoryTree();
  rebuildSolid();
  render();
}

// ===========================================================================
// STL export
// ===========================================================================

btnExport.addEventListener('click', () => {
  if (!extrudedGroup) return;
  const exporter = new THREE.STLExporter();
  const result = exporter.parse(extrudedGroup, { binary: true });
  const blob = new Blob([result.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modell.stl';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ===========================================================================
// Init
// ===========================================================================

resizeCanvas();
centerView();
render();
renderShapeList();
renderHistoryTree();
initViewer();
initTextTool();
