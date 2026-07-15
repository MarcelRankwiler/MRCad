// ---------------------------------------------------------------------------
// Simple CAD - sketch (lines + circles) -> extrude -> STL export
// Shape coordinates are stored in mm ("world space"). The sketch canvas can be
// zoomed/panned (viewScale/viewOffset); screenToWorld/worldToScreen convert
// between CSS-pixel screen space and mm world space.
// ---------------------------------------------------------------------------

// ---- state ----------------------------------------------------------------
let shapes = [];          // {id, type:'polygon'|'circle', points:[{x,y}]|null, center, radius, closed, isHole, isAdditive, additiveHeight, additiveSide:'top'|'bottom'|'center', holeDepth}
                           // every shape is either isAdditive (grows from the sketch plane Z=0 by its own additiveHeight, toward +Z ('top'), -Z ('bottom'), or split evenly both ways ('center'))
                           // or isHole (cuts from Z=0 by its own holeDepth, same 'top'/'bottom'/'center' meaning via additiveSide) - see buildBaseGroup()
                           // text-tool pieces are plain `polygon` shapes too (kind:'text', char - see textToShapePieces)
                           // multi-piece placements (text, hole-circle patterns) share a `groupId` so they select/drag/edit together
                           // polygon shapes may also have filletRadii: {vertexIndex: radiusMm} - rounded corners - and/or
                           // curveBulges: {edgeIndex: bulge} - bent edges (line tool, Shift-drag) - see getOutlinePoints()
let nextShapeId = 1;
let currentTool = 'line';
let drawingPoints = [];   // in-progress polygon points
let drawingBulges = {};   // in-progress polyline's curved edges: {edgeIndex: bulge} - see arcBulgePoints()
let curveBulgeActive = false; // true while Shift is held during/after placing a point, bending the edge that just ended there
let curveBulgeEdgeIndex = null; // drawingBulges key the mouse is currently adjusting, while curveBulgeActive
let closePending = false; // true while bending the closing edge (Shift-click on the start point) - finishPolygon() runs on Shift-up instead of immediately
let circleCenter = null;  // in-progress circle center
let shapeStartPoint = null; // in-progress rect/regular-polygon tool: first click (corner or center)
let splineProfileCenter = null; // in-progress Vielkeilprofil tool: center placed by the last click, while the panel is being configured - see computeSplineProfile()
let splineProfileEditId = null; // id of an existing 'splineprofile' shape currently bound to the panel for post-hoc editing (via the shape list's "Bearbeiten" button), or null
let polygonEditId = null; // id of an existing 'polygon' shape currently bound to the panel for post-hoc editing (via the shape list's "Bearbeiten" button), or null - see openPolygonEditor()
let textEditGroupId = null; // groupId of an existing 'text' shape group currently bound to the panel for post-hoc editing (via the shape list's "Bearbeiten" button), or null - see openTextEditor()
let mousePos = null;      // current mouse position (canvas space), for previews
let selectedShapeIds = new Set(); // Ctrl/Cmd-click adds/removes a shape in the 'select' tool, for multi-drag/multi-edit
let selectedSegment = null; // 'lineselect' tool: {shapeId, segIndex} of the currently picked edge, or null - Delete opens the shape at that edge
let alignGuideSeg = null; // 'alignline' tool: {shapeId, segIndex} of the picked guide line, waiting for a follow-line click - see performAlignLine()
let dimCtrlHeld = false;  // Ctrl/Cmd held while the 'dimension' tool is active - switches its click behavior from openLengthEditor to the fixed/driven distance pick below, see distanceFixedSel
let distanceFixedSel = null; // 'dimension' tool + Ctrl: {type:'point'|'line', shapeId, ...} of the picked fixed point/line, waiting for the driven point/line click - see performDistance()
let distEditor = null;    // active distance <input> ("Lineal") overlay, if any - see openDistanceEditor()
let reopenedShape = null;   // an open (shape.open) polygon lifted into drawingPoints for re-closing with the line tool - its props/points, restored on cancel, reapplied on finishPolygon
let errorShapeId = null;  // shape blamed for the most recent failed extrude (see buildBaseGroup/rebuildSolid) - drawn in red until the next extrude attempt
let extrudedGroup = null; // THREE.Group currently in the viewer, exportable
// True once the current sketch state has been explicitly confirmed via
// "Übernehmen" (rebuildSolid succeeding) - as opposed to merely reflected in
// the always-on live preview (see runLivePreview), which keeps `extrudedGroup`
// up to date but does NOT set this. Gates "Neue Skizze auf Fläche"/"Neue
// Ebene" (see updateFaceEditUI): starting a face/plane feature is deliberately
// only allowed against a model the user has actively confirmed, not one
// that's merely being live-previewed mid-edit. Reset to false by markDirty()
// on every sketch change.
let modelCommitted = false;
let dimEditor = null;     // active length/radius <input> overlay, if any
let pointEditor = null;   // active point-mode X/Y <input> overlay, if any
let filletEditor = null;  // active corner-radius <input> overlay, if any (see filletCornerArc)
let pivotEditor = null;   // active center-point-tool pivot X/Y <input> overlay, if any (see openPivotEditor)
let history = [];         // stack of previous `shapes` snapshots, for undo
let dragState = null;     // active shape-drag: {shapeId, original, startRaw, dx, dy, moved}
let pointDragState = null; // active point-tool drag: {hit, startRaw, moved, orig} - see updatePointDrag()
let pivotDragState = null; // active center-point-tool drag: {hit, startRaw, moved, orig} - see updatePivotDrag()
let rKeyDown = false;      // R held down - modifies the select-tool drag below into a rotate
let rotateDragState = null; // active R+drag rotate (select tool): {shapeIds, pivot, originals, startAngle, moved} - see updateRotateDrag()
let backgroundImages = []; // reference images for the CURRENT sketch (base, or the active face feature) -
                            // {id, dataUrl (base64, persisted), el (loaded HTMLImageElement, NOT persisted),
                            //  x1,y1,x2,y2 (two diagonal world-space corners, order-independent)} - purely a
                            // 2D drawing reference, does not participate in extrusion/history
let nextBgImageId = 1;
let selectedBgImageId = null; // single image selection, only shown/editable while currentTool === 'select'
let bgImageDragState = null;  // active image move/resize: {id, corner:'x1y1'|'x2y1'|'x1y2'|'x2y2'|null (null = move), orig:{x1,y1,x2,y2}, startRaw}
let viewScale = 1;        // world mm -> screen CSS px zoom factor
let viewOffset = { x: 0, y: 0 }; // screen px position of world origin (0,0)
let panState = null;      // active view pan (middle-mouse drag): {startX, startY, startOffset}
let refLineAngle = null;  // world-space angle (rad) of an Alt-selected reference line, while drawing
let refLineSeg = null;    // {a,b} endpoints of the reference line, for highlighting
let angleLockActive = false; // true while Ctrl is held during line drawing, fixing the current segment's angle
let angleLockAngle = null;   // the fixed world-space angle (rad), captured at the moment Ctrl was pressed
let angleLockSnapHit = null; // world point the locked-angle length last snapped onto (for a highlight dot), or null
let angleLockAlignFrom = null; // world point the current snap hit is axis-aligned with (for a dashed guide line), or null

// ---- face-editing state -----------------------------------------------------
// faceFeatures: ordered list of applied face-sketch features (boss/pocket geometry
// sketched on a picked planar face of the extruded solid, or on a free-standing
// datum plane - see computeCustomPlaneBasis), each:
// {id, basis:{origin,normal,uAxis,vAxis} (THREE.Vector3, "centered model space"),
//  boundaryLoopUV:[{x,y}], innerLoopsUV:[[{x,y}]], modelReferenceUV:[[{x,y}],...]
//  (datum-plane features only - the rest of the model's edges projected onto this
//  plane at creation time, shown as a sketch reference, see projectSolidEdgesToUV),
//  shapes:[...], backgroundImages:[...]}
let faceFeatures = [];
let nextFeatureId = 1;
let faceSelectMode = false;  // waiting for a click on the 3D model to pick a face
let faceSelectPurpose = 'edit'; // what a picked face does: 'edit' (sketch on it) or 'exportDxf' (export its outline)
// while sketching a face feature: {featureId|null (null = new), basis, boundaryLoopUV,
// innerLoopsUV, modelReferenceUV, baseShapes, baseHistory} - baseShapes/baseHistory are
// the stashed base sketch's `shapes`/`history`, restored on exit
let faceEditContext = null;
let baseRollback = false; // true while the history tree is temporarily rolled back to the base sketch (3D preview shows base only, "Übernehmen" pending - see runLivePreview)
// id of the faceFeatures entry whose sketch is currently loaded into
// `shapes`/`history`/`backgroundImages` for 2D display/editing, or null if
// the base sketch is loaded there instead. Independent of faceEditContext,
// which is only non-null while *actively*, not-yet-committed mid-editing -
// after "Übernehmen"/"Abbrechen" faceEditContext goes back to null, but
// activeFeatureId can stay pointed at the just-finished feature so its
// sketch remains the one shown/editable in the 2D view without needing to be
// reopened - switching the display to a different sketch (including back to
// the base) only happens via an explicit Verlauf click (see
// goToTimelineEntry/reopenFaceFeature/deleteFaceFeature).
let activeFeatureId = null;
// {shapes, backgroundImages} - the base sketch's own data, stashed here the
// moment `shapes` stops pointing at it (see enterFaceEditMode) so it survives
// even after "Übernehmen" leaves activeFeatureId pointed at a feature instead
// of restoring the base automatically. Null whenever the base sketch IS what
// `shapes` currently holds (i.e. whenever activeFeatureId is null) - see
// currentBaseSketch().
let baseShapesStash = null;
let meshVersion = 0;         // bumped whenever extrudedGroup is rebuilt; invalidates faceAdjacencyCache
let faceAdjacencyCache = null; // {version, byObject: Map(mesh -> adjacency)}
let hoverFaceHighlight = null;    // THREE.Mesh overlay for the currently hovered pickable face
let selectedFaceHighlight = null; // THREE.Mesh overlay for the face currently being sketched on

// ---- free-standing "new plane" (datum plane) state ---------------------------
// A datum plane isn't tied to any picked face of the mesh - its basis is
// computed from an axis/offset/angle triple instead (see computeCustomPlaneBasis).
// Once created it becomes a regular faceFeature (enterFaceEditMode/exitFaceEditMode
// with featureId:null), so it gets the exact same history entry, sketch/extrude
// flow, and real boolean fuse/cut against the existing solid as any other
// face-sketch feature - no separate code path needed for that part.
let newPlaneMode = false;    // true while the "Neue Ebene" config panel is open (before commit)
let newPlaneConfig = { axis: 'z', offset: 0, angle: 0, flip: false };
let newPlanePreviewGroup = null; // THREE.Group overlay showing where the plane would land

// ---- 3D edge fillets ---------------------------------------------------------
// edgeFillets: ordered list of real BREP fillets applied to the finished solid
// (after the base sketch and every face feature), each: {id, point:{x,y,z}, radius}.
// `point` is the picked edge's own midpoint in fixed world coordinates at the moment
// it was picked - same "fixed absolute position, doesn't chase the surface" approach
// as face features (see applyFaceFeaturesSubset), and the only practical one here:
// a filletted edge is consumed (replaced by a new rounded face and two new edges), so
// there's no stable identity to track across rebuilds anyway - see applyEdgeFillets().
let edgeFillets = [];
let nextEdgeFilletId = 1;
// The replicad Shape3D currently shown in the viewer (base + face features + edge
// fillets) - kept around only so the 3D-edge tool can pick real BREP edges off of
// exactly what's on screen; rebuilt alongside extrudedGroup, see rebuildSolid().
let currentSolidForPicking = null;
let hoverEdgeHighlight = null;    // THREE.Line overlay for the currently hovered pickable edge
let selectedEdgeHighlight = null; // THREE.Line overlay for the edge pending a fillet radius
let edgeFilletEditor = null;      // { input, wrap, point } - open radius input for a picked edge

const CLOSE_SNAP_PX = 10;
const SEGMENT_HIT_PX = 8;
const POINT_HIT_PX = 8;
const LENGTH_SNAP_PX = 10;
const HISTORY_LIMIT = 100;
const MIN_SCALE = 0.2;
const MAX_SCALE = 40;
// Hard cap on a curved edge's bulge magnitude (see arcBulgePoints) - a huge bulge sweeps
// its arc almost all the way around a full circle from one endpoint to the other, which
// on most shapes ends up crossing the polygon's other edges and produces a self-
// intersecting outline. OpenCascade doesn't reject that at draw time - it fails deep
// inside the solid-building step instead (see rebuildSolid()'s try/catch), so this cap
// just makes it harder to get there by accident via one wild mouse drag; it doesn't
// guarantee a self-intersection-free shape (that depends on the whole polygon, not just
// one edge's bulge).
const MAX_BULGE = 8;

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
const gridUnitInput = document.getElementById('grid-unit');
const gridOnInput = document.getElementById('grid-on');
const angleStepInput = document.getElementById('angle-step');
const angleOnInput = document.getElementById('angle-on');
const rasterDistanceInput = document.getElementById('raster-distance-on');
const shapeListEl = document.getElementById('shape-list');
const extrudeStatusEl = document.getElementById('extrude-status');
const btnExtrude = document.getElementById('btn-extrude');
const btnExport = document.getElementById('btn-export');
const btnExportStep = document.getElementById('btn-export-step');
const btnExportDxf = document.getElementById('btn-export-dxf');
const btnUndo = document.getElementById('btn-undo');
const btnClear = document.getElementById('btn-clear');
const btnSaveProject = document.getElementById('btn-save-project');
const btnLoadProject = document.getElementById('btn-load-project');
const loadProjectInput = document.getElementById('load-project-input');
const btnInsertBgImage = document.getElementById('btn-insert-bg-image');
const bgImageInput = document.getElementById('bg-image-input');

// BREP kernel (OpenCascade via replicad, see js/oc-init.js) loads
// asynchronously - keep "Übernehmen" disabled with a status message until
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

const MM_PER_INCH = 25.4;

// World coordinates are always mm internally - the Snap-Raster field just lets
// the user type/read that grid size in inches instead, converted here.
function getGridSize() {
  const raw = Math.max(0.001, parseFloat(gridSizeInput.value) || 10);
  return gridUnitInput.value === 'in' ? raw * MM_PER_INCH : raw;
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
  return tool === 'rect' || tool === 'heart' || tool.startsWith('poly');
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

// Outline of a heart shape (classic parametric heart curve), centered on
// `center` and scaled so its bottom tip sits `r` away from that center -
// mirrors how a poly-N tool's radius reaches each vertex.
function heartPoints(center, r, segments = 60) {
  const raw = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    raw.push({
      x: 16 * Math.pow(Math.sin(t), 3),
      y: 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
    });
  }
  const ys = raw.map(pt => pt.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const midY = (minY + maxY) / 2;
  const scale = r / ((maxY - minY) / 2);
  // y is negated so the tip points toward larger screen-Y (down), the
  // customary "upright" heart orientation.
  return raw.map(pt => ({ x: center.x + scale * pt.x, y: center.y - scale * (pt.y - midY) }));
}

// Reads the "Anzahl Ecken" input for the Polygon tool, clamped to [3, 100]
// integer sides (defaults to 6 if the field is empty/invalid).
function polygonToolSides() {
  const raw = Math.round(parseFloat(document.getElementById('polygon-sides').value));
  if (!Number.isFinite(raw)) return 6;
  return Math.min(100, Math.max(3, raw));
}

// Reads the "Rundung (mm)" input for the Polygon tool - a corner-fillet radius applied
// to every vertex, same units/meaning as the per-corner radius set by the "2D Ecken
// abrunden" tool (see applyFillet/filletCornerArc). 0 (the default) means sharp corners.
function polygonToolFillet() {
  const raw = parseFloat(document.getElementById('polygon-fillet').value);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

// Shown while placing a new polygon (currentTool === 'polygon') or editing an
// existing one (polygonEditId set) - mirrors updateSplineProfilePanelVisibility.
function updatePolygonPanelVisibility() {
  // A shape can be deleted (or undone) while its editor is open - drop the
  // stale reference instead of letting "Änderungen übernehmen" silently do
  // nothing/throw.
  if (polygonEditId != null && !shapes.some(s => s.id === polygonEditId)) {
    polygonEditId = null;
  }
  const editing = polygonEditId != null;
  const show = currentTool === 'polygon' || editing;
  document.getElementById('polygon-panel-block').style.display = show ? 'block' : 'none';
  document.getElementById('polygon-edit-actions').style.display = editing ? 'flex' : 'none';
}

// Opens the panel bound to an existing 'polygon'-kind shape, pre-filled from its
// stored parameters (not re-derived from its baked/rounded points) - see
// centerX/centerY/radius/rotation/sides, set when the shape was created (or last
// edited) below. Only shapes created by the current unified Polygon tool have
// these - older poly3/poly5/poly6/poly8 shapes (from before the tools were
// merged) keep their baked points as-is and aren't editable this way.
function openPolygonEditor(shapeId) {
  const shape = shapes.find(s => s.id === shapeId);
  if (!shape || shape.kind !== 'polygon' || shape.centerX == null) return;
  document.getElementById('polygon-sides').value = shape.sides || shape.points.length;
  document.getElementById('polygon-fillet').value = (shape.filletRadii && shape.filletRadii[0]) || 0;
  polygonEditId = shapeId;
  updatePolygonPanelVisibility();
}

document.getElementById('btn-polygon-apply').addEventListener('click', () => {
  const shape = shapes.find(s => s.id === polygonEditId);
  if (!shape) { polygonEditId = null; updatePolygonPanelVisibility(); return; }
  pushHistory();
  const sides = polygonToolSides();
  shape.sides = sides;
  shape.points = regularPolygonPoints({ x: shape.centerX, y: shape.centerY }, shape.radius, sides, shape.rotation || 0);
  const fillet = polygonToolFillet();
  if (fillet > 0) {
    const filletRadii = {};
    for (let i = 0; i < sides; i++) filletRadii[i] = fillet;
    shape.filletRadii = filletRadii;
  } else {
    delete shape.filletRadii;
  }
  onShapesChanged();
  updatePolygonPanelVisibility();
  render();
});

document.getElementById('btn-polygon-cancel').addEventListener('click', () => {
  polygonEditId = null;
  updatePolygonPanelVisibility();
  render();
});

// Computes the preview/final point list for the shape currently being placed
// with a rect/poly/heart tool, given its start point and the (already
// snapped) second point.
function shapeToolPoints(tool, start, p) {
  if (tool === 'rect') return rectPoints(start, p);
  if (tool === 'heart') return heartPoints(start, dist(start, p));
  const sides = tool === 'polygon' ? polygonToolSides() : parseInt(tool.slice(4), 10);
  const r = dist(start, p);
  let angle = Math.atan2(p.y - start.y, p.x - start.x);
  if (angleOnInput.checked) {
    const stepRad = Math.max(1, parseFloat(angleStepInput.value) || 45) * Math.PI / 180;
    angle = Math.round(angle / stepRad) * stepRad;
  }
  return regularPolygonPoints(start, r, sides, angle);
}

// ===========================================================================
// Vielkeilprofil tool: a parametric involute spline/gear profile. Each tooth
// flank is a true involute of the base circle -
//   x(t) = rb*(cos t + t*sin t),  y(t) = rb*(sin t - t*cos t)
// - never approximated by line segments standing in for an arc or a
// triangle; only the *tessellation* of that exact curve (and of the tip/root
// arcs) is done with line segments, same as every other curved edge in this
// app (see filletCornerArc/arcBulgePoints above). The result is a plain
// `polygon` shape (see readSplineProfileParams/computeSplineProfile/
// splineProfilePanelState below), so it gets rendering, selection, drag,
// rotate, delete, save/load "for free" - only the panel wiring further down
// (search "Vielkeilprofil tool wiring") is specific to it.
//
// Derivation summary (standard involute gear-tooth geometry): at radius r,
// the tooth half-angle from the tooth centerline is
//   psi(r) = halfAngle(pitch) + inv(alpha_pitch) - inv(alpha_r)
// where inv(alpha) = tan(alpha) - alpha is the involute function and
// alpha_r = acos(rb/r) is the pressure angle at r. Since t = tan(alpha_r)
// parametrizes the curve above, inv(alpha_r) equals theta(t) := atan2(y(t),
// x(t)) exactly, so a flank is built by sampling t and rotating each raw
// point by a fixed offset that plants the pitch-radius point at the desired
// half-angle. For an internal profile the same base-circle math applies, but
// the *material* is the other side of the same curve - equivalent to
// evaluating it at -t (which is just y -> -y), so `mirrorFactor` flips that
// sign; this also flips which end of the flank (root or tip) sits closer to
// the tooth's own centerline, so index 0 of every sampled flank is defined
// to always be the "gap" (root) end and the last index the "own" (tip) end,
// regardless of internal/external - see rGapEnd/rOwnEnd below.
// ===========================================================================

const SPLINE_PROFILE_FLANK_SAMPLES = 12; // involute samples per flank - enough resolution without excess points

function involutePoint(rb, t) {
  return { x: rb * (Math.cos(t) + t * Math.sin(t)), y: rb * (Math.sin(t) - t * Math.cos(t)) };
}

// Rotates a point around the origin by `angle` radians (distinct from the
// existing rotatePoint(p, center, angleDeg) used elsewhere for whole-shape
// rotation, which takes degrees and an arbitrary center).
function rotateAroundOrigin(p, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// Points strictly between angleFrom and angleTo (both excluded - callers
// already have the endpoints as adjacent flank samples) along the circle of
// radius `r` centered on the origin, swept in the (assumed CCW/increasing)
// direction from angleFrom to angleTo. Same tessellation density convention
// as filletCornerArc/arcBulgePoints above.
function localArcPoints(r, angleFrom, angleTo) {
  const sweep = angleTo - angleFrom;
  const steps = Math.max(1, Math.round((Math.abs(sweep) / (Math.PI / 2)) * 8));
  const pts = [];
  for (let i = 1; i < steps; i++) {
    const a = angleFrom + sweep * (i / steps);
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

// Builds the closed, world-space outline of a parametric involute spline/gear
// profile from `params` (see readSplineProfileParams for its fields), plus a
// sparse filletRadii map for the optional root-fillet corners (consumed the
// same way as any other polygon's - see getOutlinePoints/filletCornerArc).
// On invalid input, `points` is null and `error` is a short user-facing
// message - never returns NaN/Infinity coordinates or an obviously
// self-intersecting flank.
function computeSplineProfile(params) {
  const fail = (msg) => ({ points: null, filletRadii: null, error: msg, computed: null });

  const z = Math.round(params.teeth);
  const m = params.module;
  if (!Number.isFinite(z) || z < 3) return fail('Zähnezahl muss eine ganze Zahl ≥ 3 sein.');
  if (!Number.isFinite(m) || m <= 0) return fail('Modul muss größer als 0 sein.');
  if (!Number.isFinite(params.pressureAngle) || params.pressureAngle < 1 || params.pressureAngle > 60) {
    return fail('Eingriffswinkel muss zwischen 1° und 60° liegen.');
  }
  if (!Number.isFinite(params.centerX) || !Number.isFinite(params.centerY)) {
    return fail('Mittelpunkt X/Y muss eine gültige Zahl sein.');
  }
  const alpha = (params.pressureAngle * Math.PI) / 180;
  const x = Number.isFinite(params.profileShift) ? params.profileShift : 0;

  const d = m * z;
  const rPitch = d / 2;
  const rb = rPitch * Math.cos(alpha);
  if (!(rb > 1e-6)) return fail('Ungültiger Grundkreis (Eingriffswinkel prüfen).');

  const isInternal = !!params.internal;
  const tipDefault = isInternal ? rPitch - m * (1 - x) : rPitch + m * (1 + x);
  const rootDefault = isInternal ? rPitch + m * (1.25 + x) : rPitch - m * (1.25 - x);
  const rTip = params.tipDiameter ? params.tipDiameter / 2 : tipDefault;
  const rRoot = params.rootDiameter ? params.rootDiameter / 2 : rootDefault;
  if (!(rTip > 0) || !(rRoot > 0)) return fail('Kopfkreis und Fußkreis müssen größer als 0 sein.');

  const rMin = isInternal ? rTip : rRoot;
  const rMax = isInternal ? rRoot : rTip;
  if (!(rMax > rMin + 1e-6)) return fail('Kopfkreis und Fußkreis ergeben kein gültiges Profil.');
  if (!(rMin < rPitch - 1e-6 && rMax > rPitch + 1e-6)) {
    return fail('Kopf-/Fußkreis passen nicht zum Teilkreis (Modul/Zähnezahl/Durchmesser prüfen).');
  }
  if (isInternal && rMin < rb - 1e-6) {
    return fail('Kopfkreisdurchmesser liegt unterhalb des Grundkreises.');
  }

  // Tooth thickness at the pitch circle (arc length) - standard involute-gear formula.
  const s = m * (Math.PI / 2 + 2 * x * Math.tan(alpha));
  if (!(s > 0 && s < Math.PI * rPitch)) return fail('Profilverschiebung führt zu einer ungültigen Zahndicke.');
  const halfAngPitch = s / (2 * rPitch);

  const mirrorFactor = isInternal ? -1 : 1;
  const tPitch = Math.sqrt(Math.max(0, (rPitch / rb) ** 2 - 1));
  const pitchRaw = involutePoint(rb, tPitch);
  const thetaPitchSigned = mirrorFactor * Math.atan2(pitchRaw.y, pitchRaw.x);
  const rotationForRightFlank = -halfAngPitch - thetaPitchSigned;

  // Sample the involute from the "gap" (root) end to the "own" (tip) end -
  // see the file-header comment above for why index 0 is always the gap end.
  const rGapEnd = isInternal ? rMax : rMin;
  const rOwnEnd = isInternal ? rMin : rMax;
  const tGapEnd = rGapEnd > rb ? Math.sqrt((rGapEnd / rb) ** 2 - 1) : 0;
  const tOwnEnd = Math.sqrt(Math.max(0, (rOwnEnd / rb) ** 2 - 1));

  const rawFlank = [];
  // External profile whose root circle dips below the base circle: the
  // involute doesn't exist down there, so connect with a straight radial
  // segment instead (true manufacturing undercut curves are out of scope).
  if (!isInternal && rMin < rb - 1e-6) rawFlank.push({ x: rMin, y: 0 });
  for (let i = 0; i <= SPLINE_PROFILE_FLANK_SAMPLES; i++) {
    const t = tGapEnd + (tOwnEnd - tGapEnd) * (i / SPLINE_PROFILE_FLANK_SAMPLES);
    rawFlank.push(involutePoint(rb, t));
  }

  // Local (tooth-centered) frame: right flank first, left flank is its exact
  // mirror about the tooth centerline (angle 0) - "Spiegelung der zweiten
  // Zahnflanke", per spec.
  const rightFlankLocal = rawFlank.map(rp => rotateAroundOrigin({ x: rp.x, y: mirrorFactor * rp.y }, rotationForRightFlank));
  const leftFlankLocal = rightFlankLocal.map(p => ({ x: p.x, y: -p.y }));
  const n = rightFlankLocal.length;

  const angleRightOwn = Math.atan2(rightFlankLocal[n - 1].y, rightFlankLocal[n - 1].x);
  const angleLeftOwn = Math.atan2(leftFlankLocal[n - 1].y, leftFlankLocal[n - 1].x);
  const angleRightGap = Math.atan2(rightFlankLocal[0].y, rightFlankLocal[0].x);
  const angleLeftGap = Math.atan2(leftFlankLocal[0].y, leftFlankLocal[0].x);
  if (!(angleRightOwn < -1e-6)) {
    return fail('Zahnkopf zu breit / Kopfkreis zu groß - Zahnflanken überschneiden sich.');
  }
  const pitchAngle = (2 * Math.PI) / z;
  const gapSweep = (angleRightGap + pitchAngle) - angleLeftGap;
  if (!(gapSweep > 1e-6)) {
    return fail('Zähnezahl/Modul/Profilverschiebung führen zu sich überschneidenden Zahnflanken.');
  }

  const ownArcLocal = localArcPoints(rOwnEnd, angleRightOwn, angleLeftOwn);
  const gapArcLocal = localArcPoints(rGapEnd, angleLeftGap, angleRightGap + pitchAngle);
  const toothLocal = [...rightFlankLocal, ...ownArcLocal, ...leftFlankLocal.slice().reverse()];

  const rotStart = ((params.rotation || 0) * Math.PI) / 180;
  const points = [];
  const filletRadii = {};
  const rootFillet = Math.max(0, params.rootFillet || 0);

  for (let k = 0; k < z; k++) {
    const toothAngle = rotStart + k * pitchAngle;
    const startIdx = points.length;
    toothLocal.forEach(p => {
      const rp = rotateAroundOrigin(p, toothAngle);
      points.push({ x: rp.x + params.centerX, y: rp.y + params.centerY });
    });
    const endIdx = points.length - 1;
    if (rootFillet > 0) {
      filletRadii[startIdx] = rootFillet;
      filletRadii[endIdx] = rootFillet;
    }
    gapArcLocal.forEach(p => {
      const rp = rotateAroundOrigin(p, toothAngle);
      points.push({ x: rp.x + params.centerX, y: rp.y + params.centerY });
    });
  }

  if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return fail('Berechnung ergab keine gültige Geometrie (Parameter prüfen).');
  }
  // Read-only diagnostic values for display only (see "Berechnete Werte" in the
  // panel) - purely derived from the values already computed above, no new
  // geometry rules; doesn't change what's returned to any existing caller.
  const computed = {
    pitchAngleDeg: 360 / z,
    pitchDiameter: 2 * rPitch,
    baseDiameter: 2 * rb,
    tipDiameter: 2 * rTip,
    rootDiameter: 2 * rRoot,
    circularPitch: Math.PI * m,
    pressureAngleDeg: params.pressureAngle,
  };
  return { points, filletRadii: Object.keys(filletRadii).length ? filletRadii : null, error: null, computed };
}

// ===========================================================================
// Straight-flank spline/serration profiles (DIN 5481 "Kerbverzahnung" and
// ISO 14 straight-sided splines) - deliberately NOT involutes, per spec.
// Both use the exact same construction: each tooth is a plain RADIAL wedge -
// two straight flank lines at a constant angle ±halfToothAngle from the
// tooth's own centerline, from the root circle out to the tip circle - capped
// by a real circular arc at the tip ("own" arc) and, between teeth, a real
// circular arc at the root ("gap" arc). Because the flank angle is constant
// regardless of radius, the flank is a genuine straight line (no
// tessellation needed) AND the tip/gap arc angles never depend on which of
// root/tip is numerically larger, so - unlike a tapering flank - this needs
// no internal/external mirroring trick to stay a simple, correctly-wound,
// non-self-intersecting polygon: it's safe by construction for both. This is
// a deliberate simplification for a first version (see task notes); DIN 5481
// nominally also allows non-radial flanks, not attempted here.
//
// Reuses rotateAroundOrigin/localArcPoints from the involute generator above,
// and (for the optional root fillet) the existing filletRadii/
// getOutlinePoints mechanism - no changes to either.
// ===========================================================================

// Replaces sharp corner `curr` with a small flat chamfer (two points along
// its adjacent edges, offset by `size`) - same tangent-length-style clamp as
// filletCornerArc, just a flat cut instead of an arc. Used for the optional
// "Abflachung" (flat) corners below; baked directly into the generated
// points at creation time (unlike filletRadii, this isn't a generic per-shape
// live-editable feature, so it doesn't touch getOutlinePoints).
function chamferCornerPoints(prev, curr, next, size) {
  if (!(size > 0)) return [curr];
  const v1x = prev.x - curr.x, v1y = prev.y - curr.y, len1 = Math.hypot(v1x, v1y);
  const v2x = next.x - curr.x, v2y = next.y - curr.y, len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-9 || len2 < 1e-9) return [curr];
  const t = Math.min(size, len1 * 0.499, len2 * 0.499);
  if (t < 1e-6) return [curr];
  return [
    { x: curr.x + (v1x / len1) * t, y: curr.y + (v1y / len1) * t },
    { x: curr.x + (v2x / len2) * t, y: curr.y + (v2y / len2) * t },
  ];
}

// Builds the closed, world-space outline of a radial-flank tooth profile
// (shared by computeSerrationProfile/computeStraightSidedSplineProfile
// below), given the root/tip radii, the tooth's half-angle at its centerline,
// and the optional corner treatments. `rGapEnd`/`rOwnEnd` mean exactly what
// they do in computeSplineProfile above (gap = root, own = tip, always -
// regardless of internal/external, which is already baked into which of the
// two is numerically larger by the caller). Returns {points, filletRadii,
// error} - never NaN/Infinity coordinates, and rejects (with a short German
// message) any input that would make the flanks or gap overlap.
function assembleRadialFlankProfile({ z, rGapEnd, rOwnEnd, halfToothAngle, rotation, centerX, centerY, rootFillet, tipFlat, rootFlat }) {
  const fail = (msg) => ({ points: null, filletRadii: null, error: msg });
  if (!(rGapEnd > 0) || !(rOwnEnd > 0)) return fail('Kopf- und Fußkreis müssen größer als 0 sein.');
  const pitchAngle = (2 * Math.PI) / z;
  if (!(halfToothAngle > 1e-6)) return fail('Flankenwinkel bzw. Zahnbreite muss größer als 0 sein.');
  if (!(halfToothAngle * 2 < pitchAngle - 1e-9)) {
    return fail('Flankenwinkel bzw. Zahnbreite ist zu groß für die Zähnezahl - Zahnflanken überschneiden sich.');
  }

  const rightGapPoint = { x: rGapEnd * Math.cos(-halfToothAngle), y: rGapEnd * Math.sin(-halfToothAngle) };
  const rightOwnPoint = { x: rOwnEnd * Math.cos(-halfToothAngle), y: rOwnEnd * Math.sin(-halfToothAngle) };
  const leftOwnPoint = { x: rightOwnPoint.x, y: -rightOwnPoint.y };
  const leftGapPoint = { x: rightGapPoint.x, y: -rightGapPoint.y };

  const ownArcLocal = localArcPoints(rOwnEnd, -halfToothAngle, halfToothAngle);
  const gapArcLocal = localArcPoints(rGapEnd, halfToothAngle, pitchAngle - halfToothAngle);

  // One tooth's local (unrotated) sharp-cornered outline: gap-right -> flank
  // -> own-right -> [tip arc] -> own-left -> flank -> gap-left. The following
  // gap-arc (between this tooth and the next) is appended per-repetition below.
  const toothLocal = [rightGapPoint, rightOwnPoint, ...ownArcLocal, leftOwnPoint, leftGapPoint];
  const ownRightIdx = 1;
  const ownLeftIdx = 2 + ownArcLocal.length;
  const gapLeftIdx = toothLocal.length - 1; // gapRightIdx is always 0

  const points = [];
  const filletRadii = {};
  const chamferSizes = []; // parallel to `points` - resolved into flat cuts in the finishing pass below

  for (let k = 0; k < z; k++) {
    const toothAngle = rotation + k * pitchAngle;
    toothLocal.forEach((p, i) => {
      const rp = rotateAroundOrigin(p, toothAngle);
      points.push({ x: rp.x + centerX, y: rp.y + centerY });
      const isOwnCorner = i === ownRightIdx || i === ownLeftIdx;
      const isGapCorner = i === 0 || i === gapLeftIdx;
      chamferSizes.push(isOwnCorner ? (tipFlat > 0 ? tipFlat : 0) : (isGapCorner && !(rootFillet > 0) ? (rootFlat > 0 ? rootFlat : 0) : 0));
      if (isGapCorner && rootFillet > 0) filletRadii[points.length - 1] = rootFillet;
    });
    gapArcLocal.forEach(p => {
      const rp = rotateAroundOrigin(p, toothAngle);
      points.push({ x: rp.x + centerX, y: rp.y + centerY });
      chamferSizes.push(0);
    });
  }

  let finalPoints = points, finalFillet = filletRadii;
  if (chamferSizes.some(s => s > 0)) {
    // Bake the flat corner cuts in one pass over the ORIGINAL (sharp) points -
    // prev/next lookups stay correct via modulo indexing regardless of how
    // many points earlier chamfers in this same pass have already emitted.
    const n = points.length;
    const out = [];
    const filletOut = {};
    for (let i = 0; i < n; i++) {
      if (chamferSizes[i] > 0) {
        const prev = points[(i - 1 + n) % n];
        const next = points[(i + 1) % n];
        chamferCornerPoints(prev, points[i], next, chamferSizes[i]).forEach(cp => out.push(cp));
      } else {
        if (filletRadii[i] != null) filletOut[out.length] = filletRadii[i];
        out.push(points[i]);
      }
    }
    finalPoints = out;
    finalFillet = filletOut;
  }

  if (finalPoints.length < 3 || finalPoints.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return fail('Berechnung ergab keine gültige Geometrie (Parameter prüfen).');
  }
  return { points: finalPoints, filletRadii: Object.keys(finalFillet).length ? finalFillet : null, error: null };
}

// DIN 5481 "Kerbverzahnung" - a straight-flank serration, NOT an involute
// (see the derivation note above assembleRadialFlankProfile). `params.flankAngle`
// (Lückenwinkel, degrees) is the angular width of the space between two
// teeth - constant at every radius, since the flanks are radial lines.
function computeSerrationProfile(params) {
  const fail = (msg) => ({ points: null, filletRadii: null, error: msg, computed: null });
  const z = Math.round(params.teeth);
  if (!Number.isFinite(z) || z < 3) return fail('Zähnezahl muss eine ganze Zahl ≥ 3 sein.');
  if (!Number.isFinite(params.centerX) || !Number.isFinite(params.centerY)) {
    return fail('Mittelpunkt X/Y muss eine gültige Zahl sein.');
  }
  const nominalD = params.nominalDiameter;
  if (!Number.isFinite(nominalD) || nominalD <= 0) return fail('Nenndurchmesser muss größer als 0 sein.');
  const tipD = params.tipDiameter, rootD = params.rootDiameter;
  if (!Number.isFinite(tipD) || tipD <= 0 || !Number.isFinite(rootD) || rootD <= 0) {
    return fail('Kopfkreis- und Fußkreisdurchmesser müssen größer als 0 sein.');
  }
  const isInternal = !!params.internal;
  if (isInternal ? !(rootD > tipD) : !(tipD > rootD)) {
    return fail(isInternal
      ? 'Bei Innenverzahnung muss der Fußkreisdurchmesser größer als der Kopfkreisdurchmesser sein.'
      : 'Bei Außenverzahnung muss der Kopfkreisdurchmesser größer als der Fußkreisdurchmesser sein.');
  }
  const rTip = tipD / 2, rRoot = rootD / 2;
  const rMin = Math.min(rTip, rRoot), rMax = Math.max(rTip, rRoot);
  if (!(nominalD / 2 > rMin + 1e-6 && nominalD / 2 < rMax - 1e-6)) {
    return fail('Nenndurchmesser muss zwischen Fußkreis- und Kopfkreisdurchmesser liegen.');
  }
  const gapAngleDeg = params.flankAngle;
  const pitchAngleDeg = 360 / z;
  if (!Number.isFinite(gapAngleDeg) || gapAngleDeg <= 0 || gapAngleDeg >= pitchAngleDeg) {
    return fail('Lückenwinkel muss größer als 0° und kleiner als der Teilungswinkel (360°/Zähnezahl) sein.');
  }
  const halfToothAngle = ((pitchAngleDeg - gapAngleDeg) * Math.PI) / 180 / 2;

  const assembled = assembleRadialFlankProfile({
    z, rGapEnd: rRoot, rOwnEnd: rTip, halfToothAngle,
    rotation: ((params.rotation || 0) * Math.PI) / 180,
    centerX: params.centerX, centerY: params.centerY,
    rootFillet: Math.max(0, params.rootFillet || 0),
    tipFlat: Math.max(0, params.tipFlat || 0),
    rootFlat: Math.max(0, params.rootFlat || 0),
  });
  if (assembled.error) return fail(assembled.error);
  const computed = {
    pitchAngleDeg,
    circularPitch: ((pitchAngleDeg * Math.PI) / 180) * (nominalD / 2),
    tipDiameter: tipD,
    rootDiameter: rootD,
  };
  return { points: assembled.points, filletRadii: assembled.filletRadii, error: null, computed };
}

// ISO 14 straight-sided spline - also NOT an involute. `params.toothWidth`
// (Zahnbreite/Nutbreite, mm) is measured at the mean of inner/outer diameter
// and converted to the same constant flank half-angle every tooth uses (see
// assembleRadialFlankProfile) - for external it's the tooth's own material
// width, for internal the width of the groove it must leave open (the
// material width is then the remaining pitch, see materialArcWidth below).
function computeStraightSidedSplineProfile(params) {
  const fail = (msg) => ({ points: null, filletRadii: null, error: msg, computed: null });
  const z = Math.round(params.teeth);
  if (!Number.isFinite(z) || z < 3) return fail('Zähnezahl/Keilanzahl muss eine ganze Zahl ≥ 3 sein.');
  if (!Number.isFinite(params.centerX) || !Number.isFinite(params.centerY)) {
    return fail('Mittelpunkt X/Y muss eine gültige Zahl sein.');
  }
  const innerD = params.innerDiameter, outerD = params.outerDiameter;
  if (!Number.isFinite(innerD) || innerD <= 0 || !Number.isFinite(outerD) || outerD <= 0) {
    return fail('Innen- und Außendurchmesser müssen größer als 0 sein.');
  }
  if (!(outerD > innerD)) return fail('Außendurchmesser muss größer als Innendurchmesser sein.');
  const isInternal = !!params.internal;
  // External: teeth grow outward from the shaft, root = inner, tip = outer.
  // Internal: teeth grow inward from the bore, root = outer, tip = inner -
  // same addendum/dedendum role swap as the involute generator uses.
  const rRoot = (isInternal ? outerD : innerD) / 2;
  const rTip = (isInternal ? innerD : outerD) / 2;
  const referenceRadius = (innerD + outerD) / 4;
  const pitchAngleDeg = 360 / z;
  const pitchArc = ((pitchAngleDeg * Math.PI) / 180) * referenceRadius;

  const width = params.toothWidth;
  if (!Number.isFinite(width) || width <= 0) return fail('Zahnbreite bzw. Nutbreite muss größer als 0 sein.');
  const materialArcWidth = isInternal ? (pitchArc - width) : width;
  if (!(materialArcWidth > 1e-6 && materialArcWidth < pitchArc - 1e-9)) {
    return fail('Zahnbreite bzw. Nutbreite passt nicht zur Zähnezahl und den Durchmessern.');
  }
  const halfToothAngle = materialArcWidth / (2 * referenceRadius);

  const assembled = assembleRadialFlankProfile({
    z, rGapEnd: rRoot, rOwnEnd: rTip, halfToothAngle,
    rotation: ((params.rotation || 0) * Math.PI) / 180,
    centerX: params.centerX, centerY: params.centerY,
    rootFillet: Math.max(0, params.rootFillet || 0),
    tipFlat: Math.max(0, params.tipFlat || 0),
    rootFlat: 0, // not offered for ISO 14 - see panel
  });
  if (assembled.error) return fail(assembled.error);
  const computed = {
    pitchAngleDeg,
    circularPitch: pitchArc,
    tipDiameter: 2 * rTip,
    rootDiameter: 2 * rRoot,
  };
  return { points: assembled.points, filletRadii: assembled.filletRadii, error: null, computed };
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
  // Some fonts' TrueType outlines (via opentype.js) emit a redundant
  // zero-length "L" command right after a curve that already ended at that
  // same point (seen e.g. in "e"/"t" of several bundled fonts) - pushing it
  // through unfiltered leaves a degenerate zero-length edge in the flattened
  // contour, which OpenCascade's face-builder rejects as a self-intersecting
  // wire even though the polygon never actually crosses itself. Skipping
  // (near-)duplicate consecutive points here fixes that at the source.
  function addPoint(x, y) {
    const last = current[current.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 1e-6) return;
    current.push({ x, y });
  }
  path.commands.forEach((cmd) => {
    if (cmd.type === 'M') {
      current = [{ x: cmd.x, y: cmd.y }];
      contours.push(current);
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'L') {
      addPoint(cmd.x, cmd.y);
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'Q') {
      for (let t = 1; t <= TEXT_CURVE_STEPS; t++) {
        const tt = t / TEXT_CURVE_STEPS, mt = 1 - tt;
        addPoint(
          mt * mt * cx + 2 * mt * tt * cmd.x1 + tt * tt * cmd.x,
          mt * mt * cy + 2 * mt * tt * cmd.y1 + tt * tt * cmd.y,
        );
      }
      cx = cmd.x; cy = cmd.y;
    } else if (cmd.type === 'C') {
      for (let t = 1; t <= TEXT_CURVE_STEPS; t++) {
        const tt = t / TEXT_CURVE_STEPS, mt = 1 - tt;
        addPoint(
          mt * mt * mt * cx + 3 * mt * mt * tt * cmd.x1 + 3 * mt * tt * tt * cmd.x2 + tt * tt * tt * cmd.x,
          mt * mt * mt * cy + 3 * mt * mt * tt * cmd.y1 + 3 * mt * tt * tt * cmd.y2 + tt * tt * tt * cmd.y,
        );
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

// Reads the current Text-panel settings into a plain object - stored on each
// placed shape as `textParams` so the whole group can be reopened later (see
// openTextEditor()) without having to reverse-engineer settings from baked
// glyph outlines.
function currentTextParams(originPoint) {
  return {
    text: document.getElementById('text-content').value,
    fontKey: document.getElementById('text-font').value,
    fontSize: Math.max(0.5, parseFloat(document.getElementById('text-size').value) || 15),
    scaleXPercent: parseFloat(document.getElementById('text-scalex').value) || 100,
    spacing: parseFloat(document.getElementById('text-spacing').value) || 0,
    originX: originPoint.x,
    originY: originPoint.y,
  };
}

// Reads the current Text-panel settings and generates shape pieces at the
// given world point (baseline start). Returns [] if fonts aren't loaded yet,
// no font is selected, or the text field is empty.
function currentTextPieces(originPoint) {
  if (!textFontsReady) return [];
  const font = loadedTextFonts[document.getElementById('text-font').value];
  const text = document.getElementById('text-content').value;
  if (!font || !text) return [];
  const p = currentTextParams(originPoint);
  return textToShapePieces(font, text, originPoint.x, originPoint.y, p.fontSize, p.scaleXPercent, p.spacing);
}

// Shown while actively placing new text (currentTool === 'text') or editing an
// existing group (textEditGroupId set) - mirrors updatePolygonPanelVisibility.
function updateTextPanelVisibility() {
  // A shape can be deleted (or undone) while its editor is open - drop the
  // stale reference instead of letting "Änderungen übernehmen" silently do
  // nothing/throw.
  if (textEditGroupId != null && !shapes.some(s => s.groupId === textEditGroupId && s.kind === 'text')) {
    textEditGroupId = null;
  }
  const editing = textEditGroupId != null;
  document.getElementById('text-panel-block').style.display = (currentTool === 'text' || editing) ? 'block' : 'none';
  document.getElementById('text-edit-actions').style.display = editing ? 'flex' : 'none';
  // Committing the whole model mid-text-edit would apply the sketch as it
  // stood before this edit (the group's old glyph shapes are only swapped
  // out for the new ones on "Änderungen übernehmen") - block that until the
  // edit is finished or cancelled, same as the Text panel's own apply/cancel
  // pair being the only way out of edit mode.
  btnExtrude.disabled = editing;
}

// Opens the panel bound to an existing text group, pre-filled from the
// `textParams` stored on its shapes when they were created (or last edited) -
// see the placement handler and btn-text-apply below. Older projects saved
// before this field existed have no textParams on their text shapes, so
// those groups simply have no "Bearbeiten" button (see renderShapeList).
function openTextEditor(groupId) {
  const shape = shapes.find(s => s.groupId === groupId && s.kind === 'text');
  if (!shape || !shape.textParams) return;
  const p = shape.textParams;
  document.getElementById('text-content').value = p.text;
  document.getElementById('text-font').value = p.fontKey;
  document.getElementById('text-size').value = p.fontSize;
  document.getElementById('text-scalex').value = p.scaleXPercent;
  document.getElementById('text-spacing').value = p.spacing;
  textEditGroupId = groupId;
  updateTextPanelVisibility();
  render();
}

document.getElementById('btn-text-apply').addEventListener('click', () => {
  const groupId = textEditGroupId;
  const oldMembers = shapes.filter(s => s.groupId === groupId && s.kind === 'text');
  if (oldMembers.length === 0) { textEditGroupId = null; updateTextPanelVisibility(); return; }
  const origin = { x: oldMembers[0].textParams.originX, y: oldMembers[0].textParams.originY };
  const pieces = currentTextPieces(origin);
  if (pieces.length === 0) return; // empty text field - keep the group as-is until it names something again
  pushHistory();
  // Height/side/mode aren't read from the (hidden-while-editing) panel
  // fields here - they're carried over as-is from the group's current
  // shapes, which the Formen-Liste row's own Loch/Aufaddieren/Höhe/Oben-Unten
  // controls already keep in sync across every member (see shapesInGroup).
  const { isHole, isAdditive, additiveHeight, additiveSide, holeDepth } = oldMembers[0];
  const textParams = currentTextParams(origin);
  oldMembers.forEach(sh => selectedShapeIds.delete(sh.id));
  shapes = shapes.filter(s => s.groupId !== groupId);
  pieces.forEach(piece => {
    shapes.push({
      id: nextShapeId++,
      type: 'polygon',
      kind: 'text',
      char: piece.char,
      groupId,
      points: piece.points,
      isHole,
      isAdditive,
      additiveHeight,
      additiveSide,
      holeDepth,
      textParams,
    });
  });
  selectedShapeIds = new Set(shapes.filter(s => s.groupId === groupId).map(s => s.id));
  textEditGroupId = null;
  onShapesChanged();
  updateTextPanelVisibility();
  render();
});

document.getElementById('btn-text-cancel').addEventListener('click', () => {
  textEditGroupId = null;
  updateTextPanelVisibility();
  render();
});

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

// Returns the along-ray distance from `from` (in unit direction `dir`) at which the point
// being placed lands level/plumb with `point` - i.e. shares its X (axis vertical) or Y
// (axis horizontal) coordinate - regardless of how far `point` itself sits off the ray.
// This is an alignment guide (like a design tool's "smart guide"), not a coincident-vertex
// snap: it lets e.g. the closing corner of a triangle line up exactly with the start point
// even though the start point isn't anywhere near the locked ray, so the angle-locked
// segment can still be matched precisely without the grid snap rounding it off that mark.
function alignmentLength(from, dir, point) {
  const proj = (point.x - from.x) * dir.x + (point.y - from.y) * dir.y;
  return proj > 0 ? proj : null;
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
// can be matched exactly to existing geometry, and onto the length that would put the
// endpoint level/plumb with any such vertex (see alignmentLength) even if that vertex is
// nowhere near the ray itself - e.g. matching the closing corner of a triangle up with its
// start point to get an exact right angle. Falls back to a plain grid-snapped length when
// nothing nearby matches either way. Also updates `angleLockSnapHit`/`angleLockAlignFrom`
// for the caller to draw a highlight at the snapped-to point (and a guide line back to the
// vertex it aligned with, when applicable).
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
  let bestAlignFrom = null;
  const consider = (length, alignFrom) => {
    if (length === null) return;
    const d = Math.abs(length - rawLength);
    if (d < bestDiff) { bestDiff = d; bestLength = length; bestAlignFrom = alignFrom || null; }
  };

  shapes.forEach(s => {
    if (s.type !== 'polygon') return;
    s.points.forEach(p => {
      consider(projectOntoRay(from, dir, p));
      consider(alignmentLength(from, dir, p), p);
    });
    for (let j = 0; j < s.points.length; j++) {
      consider(raySegmentIntersection(from, dir, s.points[j], s.points[(j + 1) % s.points.length]));
    }
  });
  for (let j = 0; j < drawingPoints.length - 1; j++) {
    consider(projectOntoRay(from, dir, drawingPoints[j]));
    consider(alignmentLength(from, dir, drawingPoints[j]), drawingPoints[j]);
    consider(raySegmentIntersection(from, dir, drawingPoints[j], drawingPoints[j + 1]));
  }

  const length = bestLength !== null ? bestLength : snapLengthForAngle(rawLength, angle, getSnapSize());
  angleLockSnapHit = bestLength !== null ? { x: from.x + dir.x * length, y: from.y + dir.y * length } : null;
  angleLockAlignFrom = bestAlignFrom;
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

  drawBackgroundImages();

  drawGrid(w, h);

  // reference outline of the face being sketched on, if any (fixed, non-interactive) -
  // while actively mid-edit, or still showing a just-committed feature's sketch
  // (see activeFeatureId)
  if (faceEditContext) {
    drawFaceReferenceOutline(faceEditContext);
  } else if (activeFeatureId != null) {
    const f = faceFeatures.find((x) => x.id === activeFeatureId);
    if (f) drawFaceReferenceOutline(f);
  }

  // finished shapes
  shapes.forEach(shape => drawShape(shape, selectedShapeIds.has(shape.id), shape.id === errorShapeId));

  if (currentTool === 'dimension') drawDimensionLabels();
  if (currentTool === 'point' || currentTool === 'origin') drawPointHandles();
  if (currentTool === 'centerpoint') drawCenterPivotHandles();
  if (currentTool === 'edge') drawEdgeHandles();
  if (currentTool === 'select') drawBackgroundImageHandles();
  if (currentTool === 'lineselect') drawLineSelectHandles();
  if (currentTool === 'alignline') drawAlignLineHandles();
  if (currentTool === 'dimension' && (dimCtrlHeld || distanceFixedSel)) drawDistanceHandles();
  if (distEditor) drawDistanceRuler();
  if (currentTool === 'line' || currentTool === 'lineselect') drawOpenShapeEnds();
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
      for (let i = 1; i < drawingPoints.length; i++) {
        const bulge = drawingBulges[i - 1];
        if (bulge) arcBulgePoints(drawingPoints[i - 1], drawingPoints[i], bulge).forEach(p => ctx.lineTo(p.x, p.y));
        else ctx.lineTo(drawingPoints[i].x, drawingPoints[i].y);
      }
      ctx.stroke();

      // the edge currently being bent (Shift held) - highlighted, with a live radius label
      if (curveBulgeActive && curveBulgeEdgeIndex !== null && drawingBulges[curveBulgeEdgeIndex]) {
        const a = drawingPoints[curveBulgeEdgeIndex], b = bulgeEdgeEndpoint(curveBulgeEdgeIndex);
        const bulge = drawingBulges[curveBulgeEdgeIndex];
        const arcPts = arcBulgePoints(a, b, bulge);
        ctx.strokeStyle = '#b48cff';
        ctx.lineWidth = 3 / viewScale;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        arcPts.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.lineWidth = 2 / viewScale;
        const halfChord = dist(a, b) / 2;
        const radius = halfChord * (1 + bulge * bulge) / (2 * Math.abs(bulge));
        const apex = arcPts[Math.floor(arcPts.length / 2)] || a;
        ctx.font = (11 / viewScale) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        drawLabelBg(apex.x, apex.y, 'R ' + radius.toFixed(1) + ' mm');
      }
    }
    let previewPoint = null;
    const last = drawingPoints[drawingPoints.length - 1];
    // while bending the closing edge, there's no "next point" preview to show - the
    // cursor is only steering that edge's bulge (rendered above), not a new vertex
    if (mousePos && !closePending) {
      angleLockSnapHit = null;
      angleLockAlignFrom = null;
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
      if (angleLockActive && angleLockSnapHit) {
        // when the snap came from an alignment guide (matching another vertex's X/Y
        // rather than landing on the vertex itself), draw a dashed line to that vertex
        // so it's clear what the endpoint just locked onto
        if (angleLockAlignFrom) {
          ctx.save();
          ctx.strokeStyle = '#37e6b3';
          ctx.lineWidth = 1 / viewScale;
          ctx.setLineDash([4 / viewScale, 4 / viewScale]);
          ctx.beginPath();
          ctx.moveTo(angleLockAlignFrom.x, angleLockAlignFrom.y);
          ctx.lineTo(angleLockSnapHit.x, angleLockSnapHit.y);
          ctx.stroke();
          ctx.restore();
        }
        dot(angleLockSnapHit, '#37e6b3', 6);
      }
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
    let pts = shapeToolPoints(currentTool, shapeStartPoint, p);
    if (currentTool === 'polygon') {
      const fillet = polygonToolFillet();
      if (fillet > 0) {
        const filletRadii = {};
        for (let i = 0; i < pts.length; i++) filletRadii[i] = fillet;
        pts = getOutlinePoints({ type: 'polygon', points: pts, filletRadii });
      }
    }
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
  if (currentTool === 'text' && textEditGroupId == null && mousePos) {
    const p = snap(mousePos);
    const pieces = currentTextPieces(p);
    ctx.strokeStyle = '#4a9eff'; // matches the additive/blue default every new shape starts as - see the placement handler below
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

  // Vielkeilprofil tool preview: live involute-profile ghost outline at the
  // placed center, recomputed from the panel's current values every frame -
  // same "just re-derive it" approach as the rect/poly-N preview above.
  if ((currentTool === 'splineprofile' && splineProfileCenter) || splineProfileEditId != null) {
    const result = computeSplineProfileForStandard(readSplineProfileParams());
    if (result.points) {
      ctx.strokeStyle = '#4a9eff';
      ctx.lineWidth = 2 / viewScale;
      ctx.setLineDash([5 / viewScale, 3 / viewScale]);
      ctx.beginPath();
      ctx.moveTo(result.points[0].x, result.points[0].y);
      for (let i = 1; i < result.points.length; i++) ctx.lineTo(result.points[i].x, result.points[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (splineProfileCenter) dot(splineProfileCenter, '#4a7dfc');
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

// Draws every background reference image of the current sketch, in insertion
// order, in world space - called before drawGrid() so images sit behind the
// grid (and, since shapes are drawn after this, behind shapes too).
function drawBackgroundImages() {
  backgroundImages.forEach(bg => {
    if (!bg.el) return; // not loaded yet (e.g. right after loadProject())
    const x = Math.min(bg.x1, bg.x2), y = Math.min(bg.y1, bg.y2);
    ctx.drawImage(bg.el, x, y, Math.abs(bg.x2 - bg.x1), Math.abs(bg.y2 - bg.y1));
  });
}

const BG_HANDLE_HIT_PX = 10;

// Draggable 4-corner bounding box for the currently selected background image,
// only while the select tool is active - see hitTestBgImageHandle()/updateBgImageDrag().
function drawBackgroundImageHandles() {
  const bg = backgroundImages.find(b => b.id === selectedBgImageId);
  if (!bg) return;
  const x = Math.min(bg.x1, bg.x2), y = Math.min(bg.y1, bg.y2);
  ctx.save();
  ctx.strokeStyle = '#ffcc55';
  ctx.lineWidth = 1.5 / viewScale;
  ctx.setLineDash([5 / viewScale, 3 / viewScale]);
  ctx.strokeRect(x, y, Math.abs(bg.x2 - bg.x1), Math.abs(bg.y2 - bg.y1));
  ctx.restore();
  [[bg.x1, bg.y1], [bg.x2, bg.y1], [bg.x1, bg.y2], [bg.x2, bg.y2]].forEach(([hx, hy]) => dot({ x: hx, y: hy }, '#ffcc55', 6));
}

function drawShape(shape, selected, isError) {
  const color = isError ? '#ff3b30' : shape.isHole ? '#cc8b2c' : shape.isAdditive ? '#4a9eff' : (selected ? '#ffcc55' : '#5fd06b');
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = (isError ? 4 : selected ? 3 : 2) / viewScale;
  if (isError) ctx.setLineDash([8 / viewScale, 5 / viewScale]);
  ctx.beginPath();
  if (shape.type === 'polygon') {
    const pts = getOutlinePoints(shape);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    // An open shape (a line was deleted with the "Linie auswählen" tool) is a
    // polyline with a gap between its last and first point, not a closed
    // region - draw it dashed and don't close/fill it, so the missing edge and
    // its two open ends read clearly as "needs re-closing".
    if (!shape.open) ctx.closePath();
  } else {
    ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, Math.PI * 2);
  }
  if (shape.open) ctx.setLineDash([6 / viewScale, 4 / viewScale]);
  ctx.stroke();
  if (!shape.open) {
    ctx.fillStyle = color + '22';
    ctx.fill();
  }
  ctx.restore();
}

// Draws the outline of the picked face (dashed, non-interactive) as a fixed
// reference underlay while sketching a face feature, so the user can see the
// face's boundary (and any pre-existing inner holes in it) while drawing.
// `source` is either the live faceEditContext (while actively mid-edit) or a
// committed faceFeatures entry (while merely displaying one as the active
// sketch post-"Übernehmen", see activeFeatureId) - both carry the same
// boundaryLoopUV/innerLoopsUV/modelReferenceUV fields.
function drawFaceReferenceOutline(source) {
  const drawLine = (loop, close) => {
    if (!loop || loop.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(loop[0].x, loop[0].y);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i].x, loop[i].y);
    if (close) ctx.closePath();
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = '#777';
  ctx.setLineDash([4 / viewScale, 3 / viewScale]);
  ctx.lineWidth = 1.5 / viewScale;
  drawLine(source.boundaryLoopUV, true);
  (source.innerLoopsUV || []).forEach((l) => drawLine(l, true));
  ctx.restore();

  // Free-standing datum-plane features (see computeCustomPlaneBasis) have no
  // picked face of their own to outline above, so instead show the whole
  // existing model's edges projected onto this plane - a flattened "footprint"
  // reference so the user can see where the model sits while sketching on a
  // plane that may not touch it at all. Frozen at the moment the plane was
  // created (see projectSolidEdgesToUV / btnCreatePlane), same "fixed
  // position" convention as boundaryLoopUV.
  const refEdges = source.modelReferenceUV;
  if (refEdges && refEdges.length) {
    ctx.save();
    ctx.strokeStyle = '#4a7dfc';
    ctx.setLineDash([3 / viewScale, 3 / viewScale]);
    ctx.lineWidth = 1 / viewScale;
    refEdges.forEach((l) => drawLine(l, false));
    ctx.restore();
  }
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
        const bulge = s.curveBulges && s.curveBulges[j];
        if (bulge) {
          const arcPts = arcBulgePoints(a, b, bulge);
          const apex = arcPts[Math.floor(arcPts.length / 2)] || a;
          drawLabelBg(apex.x, apex.y, 'R ' + radiusForBulge(dist(a, b), bulge).toFixed(1) + ' mm');
        } else {
          drawLabelBg((a.x + b.x) / 2, (a.y + b.y) / 2, dist(a, b).toFixed(1) + ' mm');
        }
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

// Center-point tool: highlights each shape's own pivot marker (orange) - its
// stored override if the tool has moved it there, otherwise its natural center
// (see effectivePivot) - plus each group's shared marker (teal, groupPivotOf).
// Kept separate from drawPointHandles()/centroidOf(), which the Punkte tool
// still uses to mean "the shape's actual position".
function drawCenterPivotHandles() {
  const shownGroups = new Set();
  shapes.forEach(s => {
    dot(effectivePivot(s), '#ff9f4a', 5);
    if (s.groupId != null && !shownGroups.has(s.groupId)) {
      shownGroups.add(s.groupId);
      const c = groupPivotOf(s.groupId);
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

// "Linie auswählen" tool: draws a thick highlight over the currently picked
// edge (selectedSegment), so it's clear which line Delete/Backspace will remove.
function drawLineSelectHandles() {
  if (!selectedSegment) return;
  const s = shapes.find(sh => sh.id === selectedSegment.shapeId);
  if (!s || s.type !== 'polygon') return;
  const n = s.points.length;
  const a = s.points[selectedSegment.segIndex];
  const b = s.points[(selectedSegment.segIndex + 1) % n];
  ctx.save();
  ctx.strokeStyle = '#ff5f5f';
  ctx.lineWidth = 4 / viewScale;
  const bulge = s.curveBulges && s.curveBulges[selectedSegment.segIndex];
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  if (bulge) arcBulgePoints(a, b, bulge).forEach(p => ctx.lineTo(p.x, p.y));
  else ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

// "Linie ausrichten" tool: highlights every clickable line (closed-polygon
// edges only, same restriction as lineselect - an open shape's phantom
// closing edge isn't a real line) so it's clear what can be picked, then
// draws the already-picked guide line on top in a distinct color while
// waiting for the follow-line click.
function drawAlignLineHandles() {
  ctx.save();
  ctx.strokeStyle = '#37e6b3';
  ctx.lineWidth = 3 / viewScale;
  shapes.forEach(s => {
    if (s.type !== 'polygon' || s.open) return;
    for (let j = 0; j < s.points.length; j++) {
      const a = s.points[j];
      const b = s.points[(j + 1) % s.points.length];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  });
  ctx.restore();
  if (!alignGuideSeg) return;
  const s = shapes.find(sh => sh.id === alignGuideSeg.shapeId);
  if (!s || s.type !== 'polygon') return;
  const n = s.points.length;
  const a = s.points[alignGuideSeg.segIndex];
  const b = s.points[(alignGuideSeg.segIndex + 1) % n];
  ctx.save();
  ctx.strokeStyle = '#ff5f5f';
  ctx.lineWidth = 4 / viewScale;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

// "Maße" tool + Ctrl: highlights every clickable line (closed-polygon edges,
// same restriction as lineselect/alignline) and point (see drawPointHandles)
// so it's clear what can be picked for the fixed/driven distance pick, then
// draws the already-picked fixed point/line on top in a distinct color while
// waiting for the driven click - see performDistance()/openDistanceEditor().
function drawDistanceHandles() {
  ctx.save();
  ctx.strokeStyle = '#37e6b3';
  ctx.lineWidth = 3 / viewScale;
  shapes.forEach(s => {
    if (s.type !== 'polygon' || s.open) return;
    for (let j = 0; j < s.points.length; j++) {
      const a = s.points[j];
      const b = s.points[(j + 1) % s.points.length];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  });
  ctx.restore();
  drawPointHandles();
  if (!distanceFixedSel) return;
  ctx.save();
  ctx.strokeStyle = '#ff5f5f';
  ctx.lineWidth = 4 / viewScale;
  if (distanceFixedSel.type === 'line') {
    const line = distSelLine(distanceFixedSel);
    if (line) {
      ctx.beginPath();
      ctx.moveTo(line.a.x, line.a.y);
      ctx.lineTo(line.b.x, line.b.y);
      ctx.stroke();
    }
  } else {
    const p = distSelPoint(distanceFixedSel);
    if (p) dot(p, '#ff5f5f', 6);
  }
  ctx.restore();
}

// Dimension "Lineal": while distEditor is open, draws a dimension line between
// the fixed reference point and where the driven point/line will land once
// the typed value is applied (perpendicular ticks at both ends) - a live
// preview that updates as the input value changes, see distEditor.axis/refFixed.
function drawDistanceRuler() {
  const { refFixed, axis, curDist, input } = distEditor;
  const val = parseFloat(input.value);
  const shownDist = !isNaN(val) && val > 0 ? val : curDist;
  const p1 = refFixed;
  const p2 = { x: refFixed.x + axis.x * shownDist, y: refFixed.y + axis.y * shownDist };
  const tick = 6 / viewScale;
  const perp = { x: -axis.y * tick, y: axis.x * tick };
  ctx.save();
  ctx.strokeStyle = '#ffcc55';
  ctx.lineWidth = 2 / viewScale;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.moveTo(p1.x - perp.x, p1.y - perp.y);
  ctx.lineTo(p1.x + perp.x, p1.y + perp.y);
  ctx.moveTo(p2.x - perp.x, p2.y - perp.y);
  ctx.lineTo(p2.x + perp.x, p2.y + perp.y);
  ctx.stroke();
  ctx.restore();
  drawLiveLabel((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 10 / viewScale, shownDist.toFixed(1) + ' mm');
}

// Marks the two open ends of every open shape (see drawShape) with a dot, so
// the user can see where to click with the line tool to continue/re-close them.
function drawOpenShapeEnds() {
  shapes.forEach(s => {
    if (!s.open || s.type !== 'polygon' || s.points.length < 2) return;
    dot(s.points[0], '#ffcc55', 6);
    dot(s.points[s.points.length - 1], '#ffcc55', 6);
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

// Per-tool keyboard/mouse shortcut cheat-sheet, shown in the side panel above "Formen" -
// see updateToolShortcuts(). Each entry is [key label, what it does].
const TOOL_SHORTCUTS = {
  line: [
    ['Klick', 'Punkt setzen (gerades Segment)'],
    ['Shift + Klick', 'Punkt setzen und Segment zu einem Bogen biegen - Stärke folgt der Maus'],
    ['Strg (halten)', 'Achse einfrieren - Länge rastet an anderen Linien/Punkten ein'],
    ['Alt + Klick', 'Linie als Referenzwinkel für das nächste Segment übernehmen'],
    ['Doppelklick / Enter', 'Form schließen'],
  ],
  circle: [
    ['Klick', 'Mittelpunkt setzen'],
    ['Ziehen + Klick', 'Radius festlegen'],
  ],
  rect: [
    ['Klick', 'Erste Ecke setzen'],
    ['Klick', 'Gegenüberliegende Ecke setzen'],
  ],
  polygon: [['Rechts', 'Anzahl Ecken einstellen'], ['Klick', 'Mittelpunkt setzen'], ['Ziehen + Klick', 'Radius und Ausrichtung festlegen']],
  heart: [['Klick', 'Mittelpunkt setzen'], ['Ziehen + Klick', 'Größe festlegen']],
  text: [['Rechts', 'Schriftart/Größe/Breite einstellen'], ['Klick', 'Linker Rand der Grundlinie']],
  holecircle: [['Rechts', 'Radius/Anzahl/Durchmesser einstellen'], ['Klick', 'Mittelpunkt setzen (wechselt danach ins Punkte-Tool)']],
  select: [
    ['Klick', 'Form auswählen/verschieben'],
    ['Strg + Klick', 'Weitere Form zur Auswahl hinzufügen/entfernen'],
    ['R + Klick + Ziehen', 'Form um ihren Mittelpunkt drehen (Winkel rastet auf das Winkel-Raster ein)'],
  ],
  lineselect: [
    ['Klick', 'Einzelne Linie einer Linienform auswählen'],
    ['Entf / Backspace', 'Gewählte Linie löschen - die Form wird dort geöffnet'],
    ['Linien-Werkzeug', 'Offene Form am Endpunkt anklicken und wieder verschließen'],
  ],
  dimension: [
    ['Klick', 'Linie, Kreis oder gebogene Linie anklicken, Länge/Radius eingeben'],
    ['Strg + Klick', 'Fixen Punkt/Linie anklicken, dann getriebenen Punkt/Linie - Lineal zum Eingeben des Abstands erscheint'],
  ],
  origin: [['Klick', 'Eckpunkt oder Mittelpunkt als neuen Ursprung setzen']],
  point: [
    ['Klick', 'Eckpunkt oder Mittelpunkt anklicken, Koordinaten bearbeiten'],
    ['Klick + Ziehen', 'Punkt an neue Position schieben (rastet auf dem Snap-Raster ein)'],
  ],
  centerpoint: [
    ['Klick', 'Mittelpunkt-Marker anklicken, Koordinaten bearbeiten'],
    ['Klick + Ziehen', 'Nur den Marker verschieben - Form bleibt an Ort und Stelle (rastet auf dem Snap-Raster ein)'],
  ],
  edge: [['Klick nahe Ecke', 'Rundungsradius eingeben (0/leer = scharfe Ecke)']],
  alignline: [
    ['Klick', 'Leitlinie wählen (Linie einer geschlossenen Form)'],
    ['Klick', 'Follow-Linie wählen - deren Objekt dreht sich um seinen Mittelpunkt, bis beide Linien parallel sind'],
    ['Escape', 'Gewählte Leitlinie verwerfen'],
  ],
  edge3d: [
    ['Klick auf 3D-Kante', 'Rundungsradius (Fillet) eingeben, Enter übernimmt'],
    ['Escape', 'Auswahl der Kante verwerfen'],
  ],
};

function updateToolShortcuts() {
  const list = document.getElementById('shortcuts-list');
  const items = TOOL_SHORTCUTS[currentTool] || [];
  list.innerHTML = items.map(([key, desc]) =>
    `<div class="shortcut-row"><span class="shortcut-key">${key}</span><span class="shortcut-desc">${desc}</span></div>`
  ).join('');
}

function setTool(tool) {
  currentTool = tool;
  cancelInProgress();
  closeLengthEditor(true);
  closeDistanceEditor(true);
  closePointEditor(true);
  closeFilletEditor(true);
  closePivotEditor(true);
  endDrag();
  endBgImageDrag();
  endRotateDrag();
  if (tool !== 'edge3d') {
    closeEdgeFilletEditor(true);
    clearHoverEdgeHighlight();
    clearSelectedEdgeHighlight();
    if (viewerRenderer) viewerRenderer.domElement.style.cursor = 'auto';
  }
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-' + tool).classList.add('active');
  document.getElementById('holecircle-panel-block').style.display = (tool === 'holecircle') ? 'block' : 'none';
  textEditGroupId = null;
  updateTextPanelVisibility();
  polygonEditId = null;
  updatePolygonPanelVisibility();
  splineProfileEditId = null;
  updateSplineProfilePanelVisibility();
  if (tool !== 'lineselect') selectedSegment = null;
  canvas.style.cursor = (tool === 'select' || tool === 'lineselect' || tool === 'dimension' || tool === 'point' || tool === 'centerpoint' || tool === 'edge' || tool === 'origin' || tool === 'alignline') ? 'pointer' : 'crosshair';
  updateToolShortcuts();
  render();
}

function cancelInProgress() {
  // If a line was lifted out of an open shape to re-close it (see line-tool
  // adoption below) but the drawing was abandoned, put that open shape back
  // exactly as it was rather than silently losing it.
  if (reopenedShape) {
    shapes.push(reopenedShape);
    reopenedShape = null;
    onShapesChanged();
  }
  drawingPoints = [];
  drawingBulges = {};
  curveBulgeActive = false;
  curveBulgeEdgeIndex = null;
  closePending = false;
  circleCenter = null;
  shapeStartPoint = null;
  splineProfileCenter = null;
  refLineAngle = null;
  refLineSeg = null;
  angleLockActive = false;
  angleLockAngle = null;
  angleLockSnapHit = null;
  angleLockAlignFrom = null;
  alignGuideSeg = null;
  distanceFixedSel = null;
}

// The additiveSide ('top'/'bottom'/'center') a freshly drawn shape should
// start with. Every shape-creation site used to hardcode 'top' regardless of
// isHole/isAdditive - but "top"/"bottom"/"center" mean the same "grows/cuts
// from the sketch plane toward +normal/-normal/both ways" for either (see
// replicadSidedSolid / applyFaceFeaturesSubset), so a hole drawn after an
// object built as "Unten" was always starting out on the wrong side of that
// object, needing to be flipped by hand every single time. Instead, inherit
// whatever side the most recently added shape in the current sketch (base or
// face/plane feature - `shapes` is whichever is currently active) is using,
// falling back to 'top' only for the very first shape.
function defaultAdditiveSide() {
  return shapes.length ? shapes[shapes.length - 1].additiveSide : 'top';
}

function finishPolygon() {
  if (drawingPoints.length >= 3) {
    const shape = { id: nextShapeId++, type: 'polygon', points: drawingPoints.slice(), isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: defaultAdditiveSide(), holeDepth: 5 };
    if (Object.keys(drawingBulges).length > 0) shape.curveBulges = { ...drawingBulges };
    // Re-closing a shape that was opened with the "Linie auswählen" tool: carry
    // over its extrude settings/kind/group so it comes back as the same solid,
    // just with a re-drawn edge (see reopenedShape adoption in the line tool).
    if (reopenedShape) {
      // The open shape was lifted out of `shapes` during adoption; put it back
      // just long enough to snapshot it, so Undo returns to the open state the
      // user was editing rather than a transient "shape briefly gone" state.
      shapes.push(reopenedShape);
      pushHistory();
      shapes.pop();
      shape.isHole = reopenedShape.isHole;
      shape.isAdditive = reopenedShape.isAdditive;
      shape.additiveHeight = reopenedShape.additiveHeight;
      shape.additiveSide = reopenedShape.additiveSide;
      shape.holeDepth = reopenedShape.holeDepth;
      if (reopenedShape.groupId != null) shape.groupId = reopenedShape.groupId;
      if (reopenedShape.kind) shape.kind = reopenedShape.kind;
      reopenedShape = null;
    } else {
      pushHistory();
    }
    shapes.push(shape);
    onShapesChanged();
  } else if (reopenedShape) {
    // Bailed out before the re-closing had enough points to form a shape -
    // restore the open shape instead of dropping it.
    shapes.push(reopenedShape);
    reopenedShape = null;
    onShapesChanged();
  }
  drawingPoints = [];
  drawingBulges = {};
  curveBulgeActive = false;
  curveBulgeEdgeIndex = null;
  closePending = false;
  refLineAngle = null;
  refLineSeg = null;
  angleLockActive = false;
  angleLockAngle = null;
  angleLockSnapHit = null;
  angleLockAlignFrom = null;
  render();
}

// "Linie auswählen" tool + Delete: removes edge `segIndex` of a closed polygon,
// turning it into an open polyline (shape.open) with a gap where that edge was.
// The vertices are re-ordered so the gap sits between the last and first point;
// both endpoints are kept so the line tool can later re-close it (adoptOpenShapeEnd).
function openShapeAtSegment(shapeId, segIndex) {
  const s = shapes.find(sh => sh.id === shapeId);
  if (!s || s.type !== 'polygon' || s.open) return;
  const n = s.points.length;
  if (n < 3) return;
  pushHistory();
  const start = (segIndex + 1) % n;
  const reordered = [];
  for (let k = 0; k < n; k++) reordered.push(s.points[(start + k) % n]);
  s.points = reordered;
  s.open = true;
  // filletRadii/curveBulges are keyed by the pre-reorder edge indices and one
  // edge is now gone, so that mapping no longer holds - drop them rather than
  // leave rounds/bends attached to the wrong edges.
  delete s.filletRadii;
  delete s.curveBulges;
  onShapesChanged();
}

// Line tool: if `raw` lands on an open shape's endpoint, lift that polyline into
// drawingPoints so the user can continue it and click the far end to re-close it
// (finishPolygon then restores the shape's extrude settings). The clicked end
// becomes the free drawing end; the other open end becomes the close target
// (drawingPoints[0]). Returns true if a shape was adopted.
function adoptOpenShapeEnd(raw) {
  const threshold = POINT_HIT_PX / viewScale;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (!s.open || s.type !== 'polygon' || s.points.length < 2) continue;
    const last = s.points.length - 1;
    const dStart = dist(raw, s.points[0]);
    const dEnd = dist(raw, s.points[last]);
    if (dStart > threshold && dEnd > threshold) continue;
    const fromEnd = dEnd <= dStart; // clicked (or nearer) the last point?
    const pts = s.points.map(p => ({ x: p.x, y: p.y }));
    drawingPoints = fromEnd ? pts : pts.reverse();
    drawingBulges = {};
    reopenedShape = s;
    shapes.splice(i, 1);
    onShapesChanged();
    return true;
  }
  return false;
}

// Finalizes whatever edge is currently being bent (Shift-drag) - shared by releasing
// Shift and by clicking while still bending. A click always ends the bend rather than
// also placing a new point at wherever it landed - that used to be a common mis-click
// (still holding Shift, clicking to "confirm" the curve) that silently added a surprise
// extra segment instead.
function commitCurveBulge() {
  if (!curveBulgeActive) return;
  if (curveBulgeEdgeIndex !== null && Math.abs(drawingBulges[curveBulgeEdgeIndex] || 0) < 0.02) {
    delete drawingBulges[curveBulgeEdgeIndex];
  }
  curveBulgeActive = false;
  curveBulgeEdgeIndex = null;
  if (closePending) {
    closePending = false;
    finishPolygon();
  } else {
    render();
  }
}

// Marks the current 3D preview as stale mid-edit (e.g. every mousemove of an
// active shape/point drag, see updateDrag/updatePointDrag) - deliberately
// does NOT touch `extrudedGroup`/the viewer scene itself, so the last-good
// mesh stays on screen (a moment out of date) instead of flashing blank,
// right up until scheduleLivePreview()'s debounced rebuild replaces it -
// called separately, once, from onShapesChanged() when the edit completes.
function markDirty() {
  btnExport.disabled = true;
  btnExportStep.disabled = true;
  extrudeStatusEl.textContent = '';
  currentSolidForPicking = null;
  modelCommitted = false;
  updateFaceEditUI();
}

function onShapesChanged() {
  renderShapeList();
  markDirty();
  scheduleLivePreview();
}

canvas.addEventListener('mousemove', (evt) => {
  mousePos = getMousePos(evt);
  if (dragState) updateDrag(mousePos);
  if (bgImageDragState) updateBgImageDrag(mousePos);
  if (pointDragState) updatePointDrag(mousePos);
  if (pivotDragState) updatePivotDrag(mousePos);
  if (rotateDragState) updateRotateDrag(mousePos);
  if (curveBulgeActive && curveBulgeEdgeIndex !== null) {
    const a = drawingPoints[curveBulgeEdgeIndex], b = bulgeEdgeEndpoint(curveBulgeEdgeIndex);
    const bulge = bulgeFromMouse(a, b, mousePos);
    drawingBulges[curveBulgeEdgeIndex] = Math.max(-MAX_BULGE, Math.min(MAX_BULGE, bulge));
  }
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
  closeDistanceEditor(true);
  closePointEditor(true);
  closeFilletEditor(true);
  closePivotEditor(true);
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
  closeDistanceEditor(true);
  closePointEditor(true);
  closeFilletEditor(true);
  closePivotEditor(true);
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

// How many mm of width the starting/reset zoom aims to show across the
// current canvas - a fixed 100% (1 screen px = 1 mm) leaves small parts
// (the common case here: text, small hole patterns, ...) looking tiny on a
// wide canvas, so this scales with the canvas instead of a flat 1.
const DEFAULT_VIEW_WIDTH_MM = 50;
function defaultViewScale() {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, canvas.clientWidth / DEFAULT_VIEW_WIDTH_MM));
}

document.getElementById('btn-reset-view').addEventListener('click', () => {
  viewScale = defaultViewScale();
  centerView();
  render();
});

canvas.addEventListener('mousedown', (evt) => {
  if (currentTool !== 'select' || evt.button !== 0) return;
  const raw = getMousePos(evt);

  if (!evt.ctrlKey && !evt.metaKey && !rKeyDown) {
    // Dragging a handle of the currently selected background image takes
    // priority over shape hit-testing, so handles stay grabbable even where
    // they overlap a shape underneath.
    const handleHit = hitTestBgImageHandle(raw);
    if (handleHit) {
      bgImageDragState = { id: handleHit.bg.id, corner: handleHit.corner, orig: { ...handleHit.bg }, startRaw: raw };
      canvas.style.cursor = 'grabbing';
      render();
      return;
    }
  }

  const hit = hitTestShape(raw);

  if (rKeyDown) {
    // R + Klick: rotate the clicked shape (plus its group-mates, e.g. a
    // hole-circle pattern or placed text) around its center point marker,
    // instead of moving it. Doesn't touch the current selection.
    if (!hit) return;
    const rotateIds = new Set([hit.id]);
    if (hit.groupId != null) shapes.filter(sh => sh.groupId === hit.groupId).forEach(sh => rotateIds.add(sh.id));
    const idsArr = Array.from(rotateIds);
    const pivot = hit.groupId != null ? groupPivotOf(hit.groupId) : effectivePivot(hit);
    rotateDragState = {
      shapeIds: idsArr,
      pivot,
      originals: idsArr.map(id => JSON.parse(JSON.stringify(shapes.find(s => s.id === id)))),
      startAngle: Math.atan2(raw.y - pivot.y, raw.x - pivot.x),
      moved: false,
    };
    canvas.style.cursor = 'grabbing';
    return;
  }

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
    // Shapes take priority over background images (they're drawn on top), so
    // only fall back to picking an image when no shape was hit.
    const imgHit = hitTestBgImage(raw);
    if (imgHit) {
      selectedShapeIds.clear();
      renderShapeList();
      selectedBgImageId = imgHit.id;
      bgImageDragState = { id: imgHit.id, corner: null, orig: { x1: imgHit.x1, y1: imgHit.y1, x2: imgHit.x2, y2: imgHit.y2 }, startRaw: raw };
      render();
      return;
    }
    selectedShapeIds.clear();
    selectedBgImageId = null;
    renderShapeList();
    render();
    return;
  }

  selectedBgImageId = null;

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

// R+drag rotate (Objekt-tool): angle is the total swing from the pivot->startRaw
// ray to the pivot->current-mouse ray, applied fresh to the snapshot each move
// (same re-derive-from-originals approach as updateDrag(), so it can't drift).
function updateRotateDrag(raw) {
  const { pivot, startAngle } = rotateDragState;
  const angleNow = Math.atan2(raw.y - pivot.y, raw.x - pivot.x);
  let deltaDeg = ((angleNow - startAngle) * 180) / Math.PI;
  if (angleOnInput.checked) {
    const stepDeg = Math.max(1, parseFloat(angleStepInput.value) || 45);
    deltaDeg = Math.round(deltaDeg / stepDeg) * stepDeg;
  }
  if (!deltaDeg) return;
  if (!rotateDragState.moved) {
    pushHistory(); // snapshot taken once, right before the shape actually starts rotating
    rotateDragState.moved = true;
  }
  rotateDragState.shapeIds.forEach((id, idx) => {
    const shape = shapes.find(s => s.id === id);
    if (!shape) return;
    const orig = rotateDragState.originals[idx];
    if (orig.type === 'circle') shape.center = { ...orig.center };
    else shape.points = orig.points.map(p => ({ ...p }));
    rotateShapeAround(shape, pivot, deltaDeg);
  });
  markDirty();
}

function endRotateDrag() {
  if (!rotateDragState) return;
  if (rotateDragState.moved) onShapesChanged();
  rotateDragState = null;
  canvas.style.cursor = 'pointer';
  render();
}

// Point-tool: mousedown on a vertex/center/group-center starts a potential drag rather
// than opening the coordinate editor immediately - endPointDrag() (on mouseup) decides
// which one actually happened, based on whether the mouse moved enough to snap to a
// different grid position in between. A plain click (no movement) still opens the
// editor, same as before.
canvas.addEventListener('mousedown', (evt) => {
  if (currentTool !== 'point' || evt.button !== 0) return;
  closePointEditor(true); // applies+closes any editor left open from a previous point first,
  const raw = getMousePos(evt);      // so hit-testing below sees up-to-date coordinates
  const hit = hitTestPoint(raw);
  if (!hit) return;
  pointDragState = { hit, startRaw: raw, moved: false, orig: null };
  canvas.style.cursor = 'grabbing';
});

// Center-point tool: mousedown on a shape's/group's pivot marker starts a potential drag
// of that marker only (see applyPivotMove) - never the shape's actual geometry. Same
// drag-vs-click distinction as the Punkte tool above, via pivotDragState/endPivotDrag().
canvas.addEventListener('mousedown', (evt) => {
  if (currentTool !== 'centerpoint' || evt.button !== 0) return;
  closePivotEditor(true);
  const raw = getMousePos(evt);
  const hit = hitTestCenterOnly(raw);
  if (!hit) return;
  pivotDragState = { hit, startRaw: raw, moved: false, orig: null };
  canvas.style.cursor = 'grabbing';
});

function updatePivotDrag(raw) {
  const g = getSnapSize();
  const dx = snapValue(raw.x - pivotDragState.startRaw.x, g);
  const dy = snapValue(raw.y - pivotDragState.startRaw.y, g);
  if (dx === 0 && dy === 0) return;
  if (!pivotDragState.moved) {
    pushHistory(); // snapshot taken once, right before the marker actually starts moving
    pivotDragState.moved = true;
    pivotDragState.orig = { x: pivotDragState.hit.point.x, y: pivotDragState.hit.point.y };
  }
  const { hit, orig } = pivotDragState;
  const next = { x: orig.x + dx, y: orig.y + dy };
  if (hit.kind === 'groupcenter') {
    shapes.filter(sh => sh.groupId === hit.groupId).forEach(sh => { sh.pivot = { x: next.x, y: next.y }; });
  } else {
    hit.shape.pivot = { x: next.x, y: next.y };
  }
  // A pivot move never touches actual geometry, so unlike updatePointDrag() this
  // deliberately skips markDirty() - the current 3D model/export is still fully valid.
  render();
}

function endPivotDrag() {
  if (!pivotDragState) return;
  const { hit, moved } = pivotDragState;
  pivotDragState = null;
  canvas.style.cursor = 'pointer';
  if (moved) render();
  else openPivotEditor(hit);
}

// Captures the original coordinates a point-tool drag will translate by delta, in the
// same shape/kind-specific way applyPoint() interprets a hit (see there) - a plain {x,y}
// for a single vertex or circle center, the full points array for a polygon's centroid,
// or every group member's points/center for a group-center drag.
function snapshotPointTarget(hit) {
  if (hit.kind === 'vertex') return { x: hit.shape.points[hit.index].x, y: hit.shape.points[hit.index].y };
  if (hit.kind === 'groupcenter') {
    return {
      members: shapes.filter(sh => sh.groupId === hit.groupId).map(sh => (
        sh.type === 'circle' ? { center: { ...sh.center } } : { points: sh.points.map(p => ({ ...p })) }
      )),
    };
  }
  if (hit.shape.type === 'circle') return { x: hit.shape.center.x, y: hit.shape.center.y };
  return { points: hit.shape.points.map(p => ({ ...p })) };
}

function updatePointDrag(raw) {
  const g = getSnapSize();
  const dx = snapValue(raw.x - pointDragState.startRaw.x, g);
  const dy = snapValue(raw.y - pointDragState.startRaw.y, g);
  if (dx === 0 && dy === 0) return;
  if (!pointDragState.moved) {
    pushHistory(); // snapshot taken once, right before the point actually starts moving
    pointDragState.moved = true;
    pointDragState.orig = snapshotPointTarget(pointDragState.hit);
  }
  const { hit, orig } = pointDragState;
  if (hit.kind === 'vertex') {
    hit.shape.points[hit.index] = { x: orig.x + dx, y: orig.y + dy };
  } else if (hit.kind === 'groupcenter') {
    shapes.filter(sh => sh.groupId === hit.groupId).forEach((sh, idx) => {
      const o = orig.members[idx];
      if (sh.type === 'circle') sh.center = { x: o.center.x + dx, y: o.center.y + dy };
      else sh.points = o.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    });
  } else if (hit.shape.type === 'circle') {
    hit.shape.center = { x: orig.x + dx, y: orig.y + dy };
  } else {
    hit.shape.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
  }
  markDirty();
  render();
}

function endPointDrag() {
  if (!pointDragState) return;
  const { hit, moved } = pointDragState;
  pointDragState = null;
  canvas.style.cursor = 'pointer';
  if (moved) {
    onShapesChanged();
    render();
  } else {
    openPointEditor(hit);
  }
}

// Moving/resizing a background image doesn't touch `shapes`, so unlike
// updateDrag() this never calls markDirty()/pushHistory() - the image is a
// pure 2D drawing reference and doesn't participate in extrusion or undo.
function updateBgImageDrag(raw) {
  const bg = backgroundImages.find(b => b.id === bgImageDragState.id);
  if (!bg) return;
  const st = bgImageDragState;
  if (st.corner) {
    const p = snap(raw);
    if (st.corner === 'x1y1') { bg.x1 = p.x; bg.y1 = p.y; }
    else if (st.corner === 'x2y1') { bg.x2 = p.x; bg.y1 = p.y; }
    else if (st.corner === 'x1y2') { bg.x1 = p.x; bg.y2 = p.y; }
    else if (st.corner === 'x2y2') { bg.x2 = p.x; bg.y2 = p.y; }
  } else {
    const g = getSnapSize();
    const dx = snapValue(raw.x - st.startRaw.x, g), dy = snapValue(raw.y - st.startRaw.y, g);
    bg.x1 = st.orig.x1 + dx; bg.y1 = st.orig.y1 + dy;
    bg.x2 = st.orig.x2 + dx; bg.y2 = st.orig.y2 + dy;
  }
  markProjectDirty();
}

function endBgImageDrag() {
  if (!bgImageDragState) return;
  bgImageDragState = null;
  canvas.style.cursor = 'pointer';
  render();
}

window.addEventListener('mouseup', () => { endDrag(); endBgImageDrag(); endPan(); endPointDrag(); endPivotDrag(); endRotateDrag(); });

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
    if (curveBulgeActive) {
      // a click while still bending an edge ends the bend (same as releasing Shift)
      // instead of also placing a new point wherever the click happened to land
      commitCurveBulge();
      return;
    }
    // Not drawing yet: clicking an open shape's endpoint (one left behind by the
    // "Linie auswählen" tool, see adoptOpenShapeEnd) picks up that polyline to
    // continue/re-close it instead of starting a brand-new shape.
    if (drawingPoints.length === 0 && adoptOpenShapeEnd(raw)) {
      render();
      return;
    }
    if (drawingPoints.length >= 3 && dist(raw, drawingPoints[0]) <= CLOSE_SNAP_PX / viewScale) {
      if (evt.shiftKey) {
        // bend the closing edge (last point -> start point) instead of closing right away -
        // finishPolygon() only runs once Shift is released (see the keyup handler)
        curveBulgeEdgeIndex = drawingPoints.length - 1;
        curveBulgeActive = true;
        closePending = true;
        const a = drawingPoints[curveBulgeEdgeIndex], b = drawingPoints[0];
        drawingBulges[curveBulgeEdgeIndex] = Math.max(-MAX_BULGE, Math.min(MAX_BULGE, bulgeFromMouse(a, b, mousePos || raw)));
        render();
      } else {
        finishPolygon();
      }
      return;
    }
    drawingPoints.push(nextDrawPoint(raw));
    // the reference-line constraint only applies to the segment it was selected for;
    // once that segment is placed, drop back to freehand drawing
    if (refLineAngle !== null) {
      refLineAngle = null;
      refLineSeg = null;
    }
    // Shift held while placing this point: bend the edge that just ended here, following
    // the mouse - lets straight and curved segments mix freely in the same contour.
    // Placing a point without Shift held keeps/locks it straight; the bend can only be
    // adjusted live while placing that same point, not revisited afterward.
    if (evt.shiftKey && drawingPoints.length >= 2) {
      curveBulgeEdgeIndex = drawingPoints.length - 2;
      curveBulgeActive = true;
      drawingBulges[curveBulgeEdgeIndex] = Math.max(-MAX_BULGE, Math.min(MAX_BULGE, bulgeFromMouse(drawingPoints[curveBulgeEdgeIndex], drawingPoints[curveBulgeEdgeIndex + 1], mousePos || raw)));
    } else {
      curveBulgeActive = false;
      curveBulgeEdgeIndex = null;
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
        shapes.push({ id: nextShapeId++, type: 'circle', center: circleCenter, radius: r, isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: defaultAdditiveSide(), holeDepth: 5 });
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
        const pts = shapeToolPoints(currentTool, shapeStartPoint, p);
        const shape = { id: nextShapeId++, type: 'polygon', kind: currentTool, points: pts, isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: defaultAdditiveSide(), holeDepth: 5 };
        if (currentTool === 'polygon') {
          const sides = polygonToolSides();
          shape.sides = sides;
          shape.centerX = shapeStartPoint.x;
          shape.centerY = shapeStartPoint.y;
          shape.radius = dist(shapeStartPoint, p);
          // pts[0] sits exactly at the (possibly angle-grid-snapped) placement
          // angle - see regularPolygonPoints - so this reflects the angle the
          // shape was actually built with rather than the raw mouse angle.
          shape.rotation = Math.atan2(pts[0].y - shapeStartPoint.y, pts[0].x - shapeStartPoint.x);
          const fillet = polygonToolFillet();
          if (fillet > 0) {
            shape.filletRadii = {};
            for (let i = 0; i < sides; i++) shape.filletRadii[i] = fillet;
          }
        }
        shapes.push(shape);
        onShapesChanged();
      }
      shapeStartPoint = null;
    }
    render();
  } else if (currentTool === 'text' && textEditGroupId == null) {
    const p = snap(raw);
    const pieces = currentTextPieces(p);
    if (pieces.length > 0) {
      pushHistory();
      const groupId = nextShapeId;
      const textParams = currentTextParams(p);
      const side = defaultAdditiveSide();
      pieces.forEach(piece => {
        shapes.push({
          id: nextShapeId++,
          type: 'polygon',
          kind: 'text',
          char: piece.char,
          groupId,
          points: piece.points,
          isHole: false,
          isAdditive: true,
          additiveHeight: 5,
          additiveSide: side,
          holeDepth: 5,
          textParams,
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
      const side = defaultAdditiveSide();
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
          additiveSide: side,
          holeDepth: 5,
        });
      });
      onShapesChanged();
    }
    setTool('point');
    return;
  } else if (currentTool === 'splineprofile') {
    // Click sets (or re-picks) the center - the shape itself is only created
    // once the user confirms via the panel's "Profil erstellen" button, so
    // parameters can still be tuned against the live preview first (see
    // "Vielkeilprofil tool wiring" further down).
    splineProfileCenter = snap(raw);
    document.getElementById('splineprofile-center-x').value = splineProfileCenter.x;
    document.getElementById('splineprofile-center-y').value = splineProfileCenter.y;
    updateSplineProfileStatus();
    render();
    return;
  } else if (currentTool === 'dimension') {
    if (evt.ctrlKey || evt.metaKey) {
      pickDistanceTarget(raw);
      return;
    }
    const hit = hitTestSegment(raw);
    if (hit) openLengthEditor(hit);
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
  } else if (currentTool === 'lineselect') {
    // Pick a single edge of a (still closed) line shape. The phantom closing
    // edge of an already-open shape isn't a real line, and deleting a second
    // edge would split the outline in two, so only closed polygons qualify.
    const hit = hitTestSegment(raw);
    if (hit && hit.shape.type === 'polygon' && hit.segIndex !== null && !hit.shape.open) {
      selectedSegment = { shapeId: hit.shape.id, segIndex: hit.segIndex };
    } else {
      selectedSegment = null;
    }
    render();
  } else if (currentTool === 'alignline') {
    // Same closed-polygon-only restriction as lineselect (see above) - a line
    // needs two real endpoints to have a direction.
    const hit = hitTestSegment(raw);
    const valid = hit && hit.shape.type === 'polygon' && hit.segIndex !== null && !hit.shape.open;
    if (!alignGuideSeg) {
      alignGuideSeg = valid ? { shapeId: hit.shape.id, segIndex: hit.segIndex } : null;
    } else if (valid && hit.shape.id === alignGuideSeg.shapeId && hit.segIndex === alignGuideSeg.segIndex) {
      alignGuideSeg = null; // clicking the guide line again deselects it
    } else if (valid) {
      performAlignLine(alignGuideSeg, { shapeId: hit.shape.id, segIndex: hit.segIndex });
      alignGuideSeg = null;
    } else {
      alignGuideSeg = null;
    }
    render();
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
  if ((evt.key === 'Delete' || evt.key === 'Backspace') && selectedShapeIds.size === 0 && selectedBgImageId != null) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack text editing
    evt.preventDefault();
    deleteBgImage(selectedBgImageId);
  }
  if ((evt.key === 'Delete' || evt.key === 'Backspace') && currentTool === 'lineselect' && selectedSegment) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack text editing
    evt.preventDefault();
    openShapeAtSegment(selectedSegment.shapeId, selectedSegment.segIndex);
    selectedSegment = null;
    render();
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
  // R held in the Objekt-tool: turns the next click+drag on a shape into a rotate
  // around its center point instead of a move - see the mousedown handler below.
  if (evt.key.toLowerCase() === 'r' && !rKeyDown) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack text editing
    rKeyDown = true;
  }
  // Ctrl held in the 'dimension' tool: switches clicks from openLengthEditor to
  // the fixed/driven distance pick - see pickDistanceTarget()/drawDistanceHandles().
  if ((evt.key === 'Control' || evt.key === 'Meta') && currentTool === 'dimension' && !dimCtrlHeld) {
    dimCtrlHeld = true;
    render();
  }
});

document.addEventListener('keyup', (evt) => {
  if (evt.key === 'Control' && angleLockActive) {
    angleLockActive = false;
    angleLockAngle = null;
    angleLockSnapHit = null;
    angleLockAlignFrom = null;
    render();
  }
  if (evt.key.toLowerCase() === 'r') rKeyDown = false;
  if (evt.key === 'Shift' && curveBulgeActive) commitCurveBulge();
  if ((evt.key === 'Control' || evt.key === 'Meta') && dimCtrlHeld) {
    dimCtrlHeld = false;
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

// Background images don't participate in extrusion/history (see backgroundImages
// declaration), so unlike deleteShapes() this doesn't call pushHistory()/markDirty().
function deleteBgImage(id) {
  backgroundImages = backgroundImages.filter(bg => bg.id !== id);
  if (selectedBgImageId === id) selectedBgImageId = null;
  endBgImageDrag();
  markProjectDirty();
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

function hitTestBgImage(pt) {
  for (let i = backgroundImages.length - 1; i >= 0; i--) {
    const bg = backgroundImages[i];
    const x = Math.min(bg.x1, bg.x2), y = Math.min(bg.y1, bg.y2);
    if (pt.x >= x && pt.x <= x + Math.abs(bg.x2 - bg.x1) && pt.y >= y && pt.y <= y + Math.abs(bg.y2 - bg.y1)) return bg;
  }
  return null;
}

function hitTestBgImageHandle(pt) {
  const bg = backgroundImages.find(b => b.id === selectedBgImageId);
  if (!bg) return null;
  const threshold = BG_HANDLE_HIT_PX / viewScale;
  const corners = [['x1y1', bg.x1, bg.y1], ['x2y1', bg.x2, bg.y1], ['x1y2', bg.x1, bg.y2], ['x2y2', bg.x2, bg.y2]];
  for (const [corner, cx, cy] of corners) if (dist(pt, { x: cx, y: cy }) <= threshold) return { bg, corner };
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
// getOutlinePoints() derives the actual rendered/extruded outline (sharp
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

// Tessellates a circular-arc replacement for the straight edge a->b, using the
// DXF-style "bulge" convention: bulge = tan(includedAngle/4), which conveniently
// equals sagitta/halfChord (the arc's peak offset from the chord, as a fraction of
// half the chord length) - so the same bulge value keeps its shape if a/b are later
// moved (e.g. via the point tool), rather than needing to be re-tuned. Sign of the
// bulge picks which side of a->b the arc bows toward (see bulgeFromMouse). Returns
// the points from just after `a` through (and including) `b` - callers push `a`
// itself, same convention as filletCornerArc's midpoints.
function arcBulgePoints(a, b, bulge) {
  if (!bulge) return [];
  const chordLen = dist(a, b);
  if (chordLen < 1e-6) return [];
  const theta = 4 * Math.atan(bulge); // signed included angle, a -> b
  const radius = chordLen / (2 * Math.sin(theta / 2)); // signed - see angleToCenter below
  const gamma = (Math.PI - theta) / 2; // isosceles triangle a/center/b: base angle at `a`
  const chordAngle = Math.atan2(b.y - a.y, b.x - a.x);
  const angleToCenter = chordAngle + gamma;
  // `radius` carries the sign that makes this land the center on the correct side for
  // the arc to bow the way `bulge`'s sign intends - stepping by `theta` from `a` then
  // reaches `b` exactly, however large or small the bulge is (unlike deriving the center
  // from a separate "which side" sign, which can disagree with which way `theta` sweeps).
  const center = { x: a.x + radius * Math.cos(angleToCenter), y: a.y + radius * Math.sin(angleToCenter) };
  const absRadius = Math.abs(radius);
  const startAngle = Math.atan2(a.y - center.y, a.x - center.x);
  const steps = Math.max(2, Math.round((Math.abs(theta) / (Math.PI / 2)) * 8));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const ang = startAngle + theta * (i / steps);
    pts.push({ x: center.x + absRadius * Math.cos(ang), y: center.y + absRadius * Math.sin(ang) });
  }
  return pts;
}

// Derives the bulge value (see arcBulgePoints) that a live mouse position implies for
// the edge a->b, while the user drags to bend it: proportional to how far off the
// a->b line the mouse sits, signed by which side it's on. Not clamped - callers cap it.
function bulgeFromMouse(a, b, mouse) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < 1e-6) return 0;
  const ux = dx / chordLen, uy = dy / chordLen;
  const perp = (mouse.x - a.x) * uy + (mouse.y - a.y) * -ux;
  return perp / (chordLen / 2);
}

// The other endpoint of drawingPoints[index]'s edge while it's being bent - the next
// vertex, except for the closing edge (index === length-1), which wraps back to the
// start point instead, since that edge isn't a real drawingPoints entry.
function bulgeEdgeEndpoint(index) {
  return index === drawingPoints.length - 1 ? drawingPoints[0] : drawingPoints[index + 1];
}

// The radius of the circle a bulge value traces for a given chord length - the inverse
// of the sagitta/halfChord relationship described at arcBulgePoints.
function radiusForBulge(chordLen, bulge) {
  const halfChord = chordLen / 2;
  const b = Math.abs(bulge);
  return halfChord * (1 + b * b) / (2 * b);
}

// Solves the above the other way round: what bulge gives a chord of `chordLen` an arc of
// exactly `radius`? A radius has two matching bulge magnitudes for any given chord (a
// "minor" and a "major" arc through the same two points, reciprocal of each other) - this
// picks whichever is closer to `currentBulge`'s magnitude, so nudging the radius via the
// dimension editor doesn't suddenly flip a gentle curve into a near-full loop or back.
// The chord's two endpoints are left untouched; only how far the arc bows changes.
function bulgeForRadius(chordLen, radius, currentBulge) {
  const halfChord = chordLen / 2;
  const r = Math.max(radius, halfChord); // halfChord is the tightest possible arc (a semicircle)
  const root = Math.sqrt(Math.max(0, r * r - halfChord * halfChord));
  const b1 = (r - root) / halfChord;
  const b2 = (r + root) / halfChord;
  const curAbs = Math.abs(currentBulge) || 1;
  const chosen = Math.min(MAX_BULGE, Math.abs(b1 - curAbs) <= Math.abs(b2 - curAbs) ? b1 : b2);
  return chosen * Math.sign(currentBulge || 1);
}

// The outline actually used for 2D rendering and 3D extrusion: sharp corners listed
// in `shape.filletRadii` replaced by their tangent arc, and edges listed in
// `shape.curveBulges` replaced by their bulge arc (see arcBulgePoints - set by the
// line tool's Shift-drag). Falls back to the plain `shape.points` untouched when
// there's nothing to round/bend (the overwhelmingly common case), so this is cheap
// to call on every render.
function getOutlinePoints(shape) {
  if (shape.type !== 'polygon') return shape.points;
  const hasFillet = shape.filletRadii && Object.keys(shape.filletRadii).length > 0;
  const hasBulge = shape.curveBulges && Object.keys(shape.curveBulges).length > 0;
  if (!hasFillet && !hasBulge) return shape.points;
  const pts = shape.points;
  const n = pts.length;
  const result = [];
  for (let i = 0; i < n; i++) {
    const r = hasFillet ? shape.filletRadii[i] : null;
    if (r && r > 0) {
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      filletCornerArc(prev, pts[i], next, r).forEach(p => result.push(p));
    } else {
      result.push(pts[i]);
    }
    const bulge = hasBulge ? shape.curveBulges[i] : null;
    if (bulge) {
      const next = pts[(i + 1) % n];
      arcBulgePoints(pts[i], next, bulge).forEach(p => result.push(p));
    }
  }
  return result;
}

// Distance from `pt` to the bent edge a->b (bulge per arcBulgePoints), and the point on
// that arc closest to its middle (a good spot for a length/radius label or hit midpoint) -
// measured against the actual tessellated arc, not the straight chord, so a hit/label
// lands where the curve is actually drawn even for a pronounced bulge.
function distAndApexOnArc(pt, a, b, bulge) {
  const arcPts = [a, ...arcBulgePoints(a, b, bulge)];
  let best = Infinity;
  for (let k = 0; k < arcPts.length - 1; k++) best = Math.min(best, distToSegment(pt, arcPts[k], arcPts[k + 1]));
  return { dist: best, apex: arcPts[Math.floor(arcPts.length / 2)] || a };
}

function hitTestSegment(pt) {
  const threshold = SEGMENT_HIT_PX / viewScale;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'polygon') {
      for (let j = 0; j < s.points.length; j++) {
        const a = s.points[j];
        const b = s.points[(j + 1) % s.points.length];
        const bulge = s.curveBulges && s.curveBulges[j];
        if (bulge) {
          const { dist: d, apex } = distAndApexOnArc(pt, a, b, bulge);
          if (d <= threshold) return { shape: s, segIndex: j, midpoint: apex, isCurve: true };
        } else if (distToSegment(pt, a, b) <= threshold) {
          return { shape: s, segIndex: j, midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, isCurve: false };
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

// Center-point mode: same priority as hitTestPoint() (group marker first, then
// each shape's own marker) but never matches a corner vertex, and targets each
// shape's pivot marker (effectivePivot/groupPivotOf) rather than its actual
// geometric center - see applyPivotMove().
function hitTestCenterOnly(pt) {
  const threshold = POINT_HIT_PX / viewScale;

  const checkedGroups = new Set();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.groupId == null || checkedGroups.has(s.groupId)) continue;
    checkedGroups.add(s.groupId);
    const c = groupPivotOf(s.groupId);
    if (c && dist(pt, c) <= threshold) {
      return { shape: s, kind: 'groupcenter', groupId: s.groupId, index: null, point: c };
    }
  }

  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const c = effectivePivot(s);
    if (dist(pt, c) <= threshold) {
      return { shape: s, kind: 'center', index: null, point: c };
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
// anchor 'b' keeps the end point fixed and moves the start point instead. Not used for a
// curved edge (isCurve) - there `newLength` is a radius and both endpoints stay put, only
// the bulge changes - see bulgeForRadius().
function applyLength(hit, newLength, anchor) {
  const s = hit.shape;
  if (s.type === 'circle') {
    pushHistory();
    s.radius = newLength;
    onShapesChanged();
    return;
  }
  if (hit.isCurve) {
    const a = s.points[hit.segIndex], b = s.points[(hit.segIndex + 1) % s.points.length];
    pushHistory();
    s.curveBulges[hit.segIndex] = bulgeForRadius(dist(a, b), newLength, s.curveBulges[hit.segIndex]);
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
  let currentLength;
  if (hit.isCurve) {
    const a = s.points[hit.segIndex], b = s.points[(hit.segIndex + 1) % s.points.length];
    currentLength = radiusForBulge(dist(a, b), s.curveBulges[hit.segIndex]);
  } else if (isLine) {
    currentLength = dist(s.points[hit.segIndex], s.points[(hit.segIndex + 1) % s.points.length]);
  } else {
    currentLength = s.radius;
  }

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

  if (isLine && !hit.isCurve) {
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
    // Re-labeling the origin shifts every coordinate in the sketch, including any
    // Mittelpunkt-tool pivot override - otherwise it would silently end up in the
    // wrong place relative to everything else.
    if (s.pivot) s.pivot = { x: s.pivot.x - dx, y: s.pivot.y - dy };
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

// Center-point tool: X/Y editor for a picked pivot marker - deliberately just
// X/Y, no rotation field (unlike openPointEditor's) - rotating around a custom
// pivot is a future tool, not this one; this only places the marker itself.
function openPivotEditor(hit) {
  closePivotEditor(true);

  const screenPos = worldToScreen(hit.point.x, hit.point.y);
  const wrap = document.createElement('div');
  wrap.className = 'point-editor-wrap';
  wrap.style.left = (canvas.offsetLeft + screenPos.x) + 'px';
  wrap.style.top = (canvas.offsetTop + screenPos.y) + 'px';

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

  const fields = [inputX, inputY];
  const onKeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') closePivotEditor(true);
    else if (e.key === 'Escape') closePivotEditor(false);
  };
  const onBlur = (e) => { if (!fields.includes(e.relatedTarget)) closePivotEditor(true); };
  fields.forEach(f => { f.addEventListener('keydown', onKeydown); f.addEventListener('blur', onBlur); });

  document.getElementById('sketch-pane').appendChild(wrap);
  pivotEditor = { inputX, inputY, wrap, hit };
  inputX.focus();
  inputX.select();
}

function closePivotEditor(apply) {
  if (!pivotEditor) return;
  const { inputX, inputY, wrap, hit } = pivotEditor;
  pivotEditor = null; // clear first so the blur triggered by remove() below doesn't recurse
  if (apply) {
    const x = parseFloat(inputX.value);
    const y = parseFloat(inputY.value);
    if (!isNaN(x) && !isNaN(y)) applyPivotMove(hit, x, y);
  }
  wrap.remove();
  render();
}

// Moves only the pivot marker to (x,y) - the shape's/group's actual geometry
// (points/center) is untouched. A pure bookkeeping edit, not a geometry change,
// so unlike applyPoint() this skips markDirty(): the current 3D model/export
// is still fully valid.
function applyPivotMove(hit, x, y) {
  pushHistory();
  if (hit.kind === 'groupcenter') {
    shapes.filter(sh => sh.groupId === hit.groupId).forEach(sh => { sh.pivot = { x, y }; });
  } else {
    hit.shape.pivot = { x, y };
  }
  render();
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

// poly3/poly5/poly6/poly8 remain here only for shapes saved by older versions
// (before the fixed-corner-count tools were unified into the "Polygon" tool
// below) - so files saved with those tools keep showing the right label.
const SHAPE_KIND_LABELS = { rect: 'Rechteck', poly3: 'Dreieck', poly5: 'Fünfeck', poly6: 'Sechseck', poly8: 'Achteck', heart: 'Herz', text: 'Text' };

function shapeLabel(s) {
  if (s.kind === 'holecircle') return 'Lochkreis-Loch';
  if (s.type === 'circle') return 'Kreis';
  if (s.kind === 'polygon') return `Polygon (${s.sides || s.points.length}-Eck)${s.open ? ' (offen)' : ''}`;
  if (s.kind === 'text') return `Text „${s.textParams ? s.textParams.text : s.char}“`;
  if (s.kind === 'splineprofile' && s.splineParams) {
    const p = s.splineParams;
    const standardLabel = { din5480: 'DIN 5480', iso4156: 'ISO 4156', din5481: 'DIN 5481', iso14: 'ISO 14' }[p.standard] || 'benutzerdef.';
    const side = p.internal ? 'innen' : 'außen';
    if (p.standard === 'din5481' || p.standard === 'iso14') {
      return `Vielkeilprofil (${standardLabel}, ${side}, z=${p.teeth})`;
    }
    const m = Number.isFinite(p.module) ? p.module.toFixed(3).replace(/\.?0+$/, '') : '?';
    return `Vielkeilprofil (${standardLabel}, ${side}, z=${p.teeth}, m=${m})`;
  }
  const base = SHAPE_KIND_LABELS[s.kind] || 'Linienform';
  return s.open ? base + ' (offen)' : base;
}

function centroidOf(shape) {
  if (shape.type === 'circle') return { x: shape.center.x, y: shape.center.y };
  const n = shape.points.length;
  const sum = shape.points.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / n, y: sum.y / n };
}

// ---- Mittelpunkt-tool pivot markers -------------------------------------------
// `shape.pivot` ({x,y}, optional) is a marker the center-point tool can drag
// independently of the shape's actual geometry - meant as a future rotation
// center (rotate the shape around an arbitrary point, not just its own true
// center). Deliberately kept separate from centroidOf()/hitTestPoint(), which
// the Punkte tool still uses to mean "the shape's real position" - dragging a
// center there still translates the whole shape, unaffected by any pivot here.

// Center-point tool marker for a single shape: its own pivot override if it's
// been dragged there (see applyPivotMove), otherwise its natural center.
function effectivePivot(shape) {
  return shape.pivot ? { x: shape.pivot.x, y: shape.pivot.y } : centroidOf(shape);
}

// Center-point tool marker for a whole group (e.g. a hole-circle pattern or
// placed text): the average of every member's own effectivePivot(), so the
// group's shared marker follows if some/all members have a custom pivot.
function groupPivotOf(groupId) {
  const members = shapes.filter(s => s.groupId === groupId);
  if (members.length === 0) return null;
  const sum = members.reduce((a, s) => {
    const c = effectivePivot(s);
    return { x: a.x + c.x, y: a.y + c.y };
  }, { x: 0, y: 0 });
  return { x: sum.x / members.length, y: sum.y / members.length };
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

// "Linie ausrichten" tool: rotates the follow line's whole shape (plus its
// group-mates, e.g. text letters or a hole-circle pattern) around its own
// center/pivot marker - the same pivot convention as the R+drag rotate in the
// Objekt-tool, see updateRotateDrag() - by whatever angle makes the follow
// line parallel to the guide line. A line's direction is only defined mod
// 180° (it has no arrow), so the smallest such rotation is used.
function performAlignLine(guideSeg, followSeg) {
  const guideShape = shapes.find(s => s.id === guideSeg.shapeId);
  const followShape = shapes.find(s => s.id === followSeg.shapeId);
  if (!guideShape || !followShape) return;
  // If both lines belong to the same object (or the same group, e.g. two
  // letters of one text), rotating the follow shape would drag the guide
  // line along with it and the two could never converge.
  if (guideShape.id === followShape.id || (guideShape.groupId != null && guideShape.groupId === followShape.groupId)) {
    alert('Leitlinie und Follow-Linie gehören zum selben Objekt - das lässt sich nicht ausrichten.');
    return;
  }
  const gn = guideShape.points.length;
  const ga = guideShape.points[guideSeg.segIndex];
  const gb = guideShape.points[(guideSeg.segIndex + 1) % gn];
  const fn = followShape.points.length;
  const fa = followShape.points[followSeg.segIndex];
  const fb = followShape.points[(followSeg.segIndex + 1) % fn];
  const guideDeg = (Math.atan2(gb.y - ga.y, gb.x - ga.x) * 180) / Math.PI;
  const followDeg = (Math.atan2(fb.y - fa.y, fb.x - fa.x) * 180) / Math.PI;
  let deltaDeg = ((guideDeg - followDeg) % 180 + 180) % 180;
  if (deltaDeg > 90) deltaDeg -= 180;
  if (Math.abs(deltaDeg) < 1e-9) return; // already parallel
  const pivot = followShape.groupId != null ? groupPivotOf(followShape.groupId) : effectivePivot(followShape);
  pushHistory();
  shapesInGroup(followShape).forEach(sh => rotateShapeAround(sh, pivot, deltaDeg));
  onShapesChanged();
}

// ---- "Maße" tool + Ctrl: distance between a fixed and a driven point/line ---
// Mirrors performAlignLine's two-click pick (first click = fixed/reference,
// second click = driven), but drives a translation instead of a rotation, and
// works on points as well as lines - see openDistanceEditor()/applyDistance().

// Resolves a selection's current world point - `kind`/`index`/`groupId` follow
// the same convention as hitTestPoint()'s return value.
function distSelPoint(sel) {
  const s = shapes.find(sh => sh.id === sel.shapeId);
  if (!s) return null;
  if (sel.kind === 'vertex') return s.points[sel.index];
  if (sel.kind === 'groupcenter') return groupCenterOf(sel.groupId);
  return s.type === 'circle' ? s.center : centroidOf(s);
}

// Resolves a line selection's current endpoints ({shapeId, segIndex}, closed
// polygons only - same restriction as lineselect/alignline).
function distSelLine(sel) {
  const s = shapes.find(sh => sh.id === sel.shapeId);
  if (!s || s.type !== 'polygon') return null;
  const n = s.points.length;
  return { a: s.points[sel.segIndex], b: s.points[(sel.segIndex + 1) % n] };
}

function distSelSameTarget(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'line') return a.shapeId === b.shapeId && a.segIndex === b.segIndex;
  return a.shapeId === b.shapeId && a.kind === b.kind && a.index === b.index && a.groupId === b.groupId;
}

// The polygon vertex index(es) a selection pins down: a single index for a
// vertex, both endpoints for a line - i.e. exactly the points a same-shape
// distance edit is allowed to move (see pickDistanceTarget). null for a
// selection that has no single vertex of its own (a shape's centroid/a
// circle's center, or a group's shared center) - moving "the whole shape" is
// exactly the rigid-body move a same-shape edit can't do, see below.
function distSelVertexIndices(sel, shape) {
  if (sel.type === 'point' && sel.kind === 'vertex') return [sel.index];
  if (sel.type === 'line') {
    const n = shape.points.length;
    return [sel.segIndex, (sel.segIndex + 1) % n];
  }
  return null;
}

// Hit-tests a point first (smaller/more specific target), falling back to a
// closed-polygon edge, and returns the {type, shapeId, ...} selection shape
// used throughout this section - or null if neither was hit.
function hitTestDistanceTarget(raw) {
  const pHit = hitTestPoint(raw);
  if (pHit) return { type: 'point', shapeId: pHit.shape.id, kind: pHit.kind, index: pHit.index, groupId: pHit.groupId };
  const sHit = hitTestSegment(raw);
  if (sHit && sHit.segIndex !== null && sHit.shape.type === 'polygon' && !sHit.shape.open) {
    return { type: 'line', shapeId: sHit.shape.id, segIndex: sHit.segIndex };
  }
  return null;
}

// Ctrl-click in the 'dimension' tool: first click picks the fixed reference,
// second click picks the driven point/line and opens the ruler input.
function pickDistanceTarget(raw) {
  const sel = hitTestDistanceTarget(raw);
  if (!distanceFixedSel) {
    distanceFixedSel = sel;
  } else if (sel && distSelSameTarget(sel, distanceFixedSel)) {
    distanceFixedSel = null; // clicking the fixed selection again deselects it
  } else if (sel) {
    const fixedShape = shapes.find(sh => sh.id === distanceFixedSel.shapeId);
    const drivenShape = shapes.find(sh => sh.id === sel.shapeId);
    const sameShape = fixedShape && drivenShape && fixedShape.id === drivenShape.id;
    const sameGroup = !sameShape && fixedShape && drivenShape
      && fixedShape.groupId != null && fixedShape.groupId === drivenShape.groupId;
    if (sameShape) {
      // Two points/lines of the very same shape can still be dimensioned
      // against each other - but only by moving the driven side's own
      // vertex/vertices (see distSelVertexIndices), never the whole shape:
      // translating the whole thing wouldn't change the distance between two
      // of its own points at all, since both would move together.
      const drivenIdx = distSelVertexIndices(sel, drivenShape);
      const fixedIdx = distSelVertexIndices(distanceFixedSel, fixedShape);
      if (drivenShape.type !== 'polygon' || !drivenIdx || !fixedIdx) {
        alert('Der Mittelpunkt eines Objekts hat keinen eigenen Eckpunkt, der sich unabhängig verschieben ließe - das lässt sich nicht bemaßen.');
      } else if (drivenIdx.some(i => fixedIdx.includes(i))) {
        alert('Fixer und getriebener Punkt teilen sich einen Eckpunkt - das lässt sich nicht bemaßen.');
      } else {
        openDistanceEditor(distanceFixedSel, sel, raw, drivenIdx);
      }
    } else if (sameGroup) {
      alert('Fixer und getriebener Punkt/Linie gehören zur selben Gruppe - das lässt sich nicht bemaßen.');
    } else {
      openDistanceEditor(distanceFixedSel, sel, raw);
    }
    distanceFixedSel = null;
  } else {
    distanceFixedSel = null;
  }
  render();
}

// Returns the {axis (unit vector), curDist, refFixed, refDriven} used to both
// draw the ruler and apply the new distance. `axis` always points from the
// fixed side toward the driven side, so `refFixed + axis*newDist` is where the
// driven reference point should end up. When either side is a line, the axis
// is that line's normal (perpendicular distance); with two points it's simply
// the direction between them (their distance, direction preserved).
function computeDistanceAxis(fixed, driven) {
  let axis, refFixed, refDriven;
  if (fixed.type === 'line') {
    const { a, b } = distSelLine(fixed);
    const len = dist(a, b) || 1;
    axis = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    refFixed = a;
    refDriven = driven.type === 'line' ? distSelLine(driven).a : distSelPoint(driven);
  } else if (driven.type === 'line') {
    const { a, b } = distSelLine(driven);
    const len = dist(a, b) || 1;
    axis = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    refFixed = distSelPoint(fixed);
    refDriven = a;
  } else {
    refFixed = distSelPoint(fixed);
    refDriven = distSelPoint(driven);
    const dx = refDriven.x - refFixed.x, dy = refDriven.y - refFixed.y;
    const len = Math.hypot(dx, dy);
    axis = len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  }
  let signed = (refDriven.x - refFixed.x) * axis.x + (refDriven.y - refFixed.y) * axis.y;
  if (signed < 0) { axis = { x: -axis.x, y: -axis.y }; signed = -signed; }
  return { axis, curDist: signed, refFixed, refDriven };
}

function translateShapesBy(shapesArr, dx, dy) {
  shapesArr.forEach(sh => {
    if (sh.type === 'circle') sh.center = { x: sh.center.x + dx, y: sh.center.y + dy };
    else sh.points = sh.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
    if (sh.pivot) sh.pivot = { x: sh.pivot.x + dx, y: sh.pivot.y + dy };
  });
}

// Translates the driven side along `axis` so its reference point ends up
// exactly `newDist` away from the fixed reference point along that axis.
// Normally that means the whole driven shape (and its group-mates, e.g. text
// letters or a hole-circle pattern); `vertexIdx`, if given (a same-shape
// edit - see pickDistanceTarget), instead moves only those vertex indices of
// the driven shape itself, leaving the rest of it (including the fixed side)
// untouched.
function applyDistance(fixed, driven, newDist, vertexIdx) {
  const drivenShape = shapes.find(sh => sh.id === driven.shapeId);
  if (!drivenShape) return;
  const { axis, curDist } = computeDistanceAxis(fixed, driven);
  const t = newDist - curDist;
  if (Math.abs(t) < 1e-9) return;
  pushHistory();
  if (vertexIdx) {
    vertexIdx.forEach(i => {
      const p = drivenShape.points[i];
      drivenShape.points[i] = { x: p.x + axis.x * t, y: p.y + axis.y * t };
    });
  } else {
    translateShapesBy(shapesInGroup(drivenShape), axis.x * t, axis.y * t);
  }
  onShapesChanged();
}

function closeDistanceEditor(apply) {
  if (!distEditor) return;
  const { input, wrap, fixed, driven, vertexIdx } = distEditor;
  distEditor = null; // clear first so the blur triggered by remove() below doesn't recurse
  if (apply) {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) applyDistance(fixed, driven, val, vertexIdx);
  }
  wrap.remove();
  render();
}

function openDistanceEditor(fixed, driven, clickRaw, vertexIdx) {
  closeDistanceEditor(true);
  const { axis, curDist, refFixed } = computeDistanceAxis(fixed, driven);

  const mid = { x: (refFixed.x + clickRaw.x) / 2, y: (refFixed.y + clickRaw.y) / 2 };
  const screenPos = worldToScreen(mid.x, mid.y);
  const wrap = document.createElement('div');
  wrap.className = 'dim-editor-wrap';
  wrap.style.left = (canvas.offsetLeft + screenPos.x) + 'px';
  wrap.style.top = (canvas.offsetTop + screenPos.y) + 'px';

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'dim-editor';
  input.step = '0.1';
  input.min = '0.1';
  input.value = curDist.toFixed(1);
  input.addEventListener('input', () => render()); // live-update the ruler preview
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') closeDistanceEditor(true);
    else if (e.key === 'Escape') closeDistanceEditor(false);
  });
  input.addEventListener('blur', () => closeDistanceEditor(true));
  wrap.appendChild(input);

  document.getElementById('sketch-pane').appendChild(wrap);
  distEditor = { input, wrap, fixed, driven, axis, curDist, refFixed, vertexIdx };
  input.focus();
  input.select();
  render();
}

function renderShapeList() {
  btnExportDxf.disabled = shapes.length === 0;
  shapeListEl.innerHTML = '';
  if (shapes.length === 0) {
    shapeListEl.innerHTML = '<div class="empty">Noch keine Formen gezeichnet.</div>';
    return;
  }
  // A placed text is many polygon shapes (one per glyph piece) sharing one
  // groupId - shown here as a single row (see shapeLabel's textParams.text)
  // so the list reads as "one form" per the user's mental model, matching
  // how it's edited (openTextEditor) and deleted (whole group) below.
  const seenTextGroups = new Set();
  let visibleIdx = 0;
  shapes.forEach((s) => {
    if (s.kind === 'text' && s.groupId != null) {
      if (seenTextGroups.has(s.groupId)) return;
      seenTextGroups.add(s.groupId);
    }
    visibleIdx++;
    const isSelected = s.kind === 'text' && s.groupId != null
      ? shapesInGroup(s).some(sh => selectedShapeIds.has(sh.id))
      : selectedShapeIds.has(s.id);
    const item = document.createElement('div');
    item.className = 'shape-item' + (s.isHole ? ' hole' : '') + (s.isAdditive ? ' additive' : '') + (isSelected ? ' selected' : '');

    const row = document.createElement('div');
    row.className = 'shape-item-row';
    const label = document.createElement('span');
    label.textContent = `${visibleIdx}. ${shapeLabel(s)}`;
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
        if (sh.isHole) {
          sh.isAdditive = false;
          // Carry the last-entered depth/height across the toggle - Höhe and
          // Tiefe are stored separately per shape (so switching back and forth
          // doesn't lose either value), but a value just typed while additive
          // should still apply once switched to Loch, not silently fall back
          // to whatever holeDepth happened to default to (5) - a hole that
          // ends up far shallower than intended can look like "nothing
          // happened" if it doesn't reach far enough into the material.
          sh.holeDepth = sh.additiveHeight;
        }
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
        if (sh.isAdditive) {
          sh.isHole = false;
          sh.additiveHeight = sh.holeDepth; // see holeCheckbox's handler above
        }
      });
      onShapesChanged();
    });
    addLabel.appendChild(addCheckbox);
    addLabel.appendChild(document.createTextNode(' Aufaddieren'));
    controls.appendChild(addLabel);

    if (s.kind === 'splineprofile') {
      const editBtn = document.createElement('button');
      editBtn.textContent = '✏ Bearbeiten';
      editBtn.title = 'Verzahnungsparameter dieses Profils nachträglich ändern';
      editBtn.addEventListener('click', () => openSplineProfileEditor(s.id));
      controls.appendChild(editBtn);
    }
    if (s.kind === 'polygon' && s.centerX != null) {
      const editBtn = document.createElement('button');
      editBtn.textContent = '✏ Bearbeiten';
      editBtn.title = 'Eckenzahl und Rundung dieses Polygons nachträglich ändern';
      editBtn.addEventListener('click', () => openPolygonEditor(s.id));
      controls.appendChild(editBtn);
    }
    if (s.kind === 'text' && s.textParams) {
      const editBtn = document.createElement('button');
      editBtn.textContent = '✏ Bearbeiten';
      editBtn.title = 'Text, Schriftart und weitere Einstellungen nachträglich ändern';
      editBtn.addEventListener('click', () => openTextEditor(s.groupId));
      controls.appendChild(editBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Form löschen';
    delBtn.addEventListener('click', () => {
      if (s.kind === 'text' && s.groupId != null) deleteShapes(shapesInGroup(s).map(sh => sh.id));
      else deleteShape(s.id);
    });
    controls.appendChild(delBtn);

    row.appendChild(controls);
    row.addEventListener('click', (e) => {
      if (e.target === delBtn || e.target === holeCheckbox || e.target === addCheckbox) return;
      const rowIds = s.kind === 'text' && s.groupId != null ? shapesInGroup(s).map(sh => sh.id) : [s.id];
      if (e.ctrlKey || e.metaKey) {
        if (rowIds.every(id => selectedShapeIds.has(id))) rowIds.forEach(id => selectedShapeIds.delete(id));
        else rowIds.forEach(id => selectedShapeIds.add(id));
      } else {
        selectedShapeIds = new Set(rowIds);
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

      // "Oben"/"Unten"/"Mittig": for a base-sketch shape, which way it grows
      // from the sketch plane (Z=0) - up, down, or split evenly both ways.
      // For a face/plane-feature shape, the same choice applies relative to
      // that feature's own basis normal instead of world Z (see
      // applyFaceFeaturesSubset/extrudeFaceShape) - "Oben" (the default,
      // matching every feature from before this option existed) grows outward
      // along +normal, "Unten" reverses that (into -normal), "Mittig" splits
      // evenly around the feature's own plane.
      {
        const btnTop = document.createElement('button');
        btnTop.type = 'button';
        btnTop.textContent = 'Oben';
        btnTop.title = faceEditContext ? 'Wächst entlang der Flächen-/Ebenen-Normale nach außen (Standard)' : '';
        btnTop.className = 'side-btn' + (s.additiveSide === 'top' ? ' active' : '');

        const btnBottom = document.createElement('button');
        btnBottom.type = 'button';
        btnBottom.textContent = 'Unten';
        btnBottom.title = faceEditContext ? 'Wächst entgegen der Flächen-/Ebenen-Normale (nach innen)' : '';
        btnBottom.className = 'side-btn' + (s.additiveSide === 'bottom' ? ' active' : '');

        const btnCenter = document.createElement('button');
        btnCenter.type = 'button';
        btnCenter.title = faceEditContext
          ? 'Höhe wächst je zur Hälfte entlang und entgegen der Flächen-/Ebenen-Normale'
          : 'Höhe wächst je zur Hälfte nach oben und unten aus der Skizzenebene heraus';
        btnCenter.textContent = 'Mittig';
        btnCenter.className = 'side-btn' + (s.additiveSide === 'center' ? ' active' : '');

        btnTop.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'top'; }); onShapesChanged(); });
        btnBottom.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'bottom'; }); onShapesChanged(); });
        btnCenter.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'center'; }); onShapesChanged(); });

        optRow.appendChild(btnTop);
        optRow.appendChild(btnBottom);
        optRow.appendChild(btnCenter);
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

      // "Oben"/"Unten"/"Mittig": for a base-sketch hole, which way it cuts
      // from the sketch plane (Z=0) - up, down, or symmetrically both ways.
      // For a face/plane-feature pocket, the same choice applies relative to
      // that feature's own basis normal instead of world Z (see
      // applyFaceFeaturesSubset/extrudeFaceShape) - "Oben" (the default,
      // matching every feature from before this option existed) cuts inward
      // against +normal, "Unten" reverses that (outward, along +normal),
      // "Mittig" splits evenly around the feature's own plane.
      {
        const btnTop = document.createElement('button');
        btnTop.type = 'button';
        btnTop.textContent = 'Oben';
        btnTop.title = faceEditContext ? 'Schneidet entgegen der Flächen-/Ebenen-Normale ins Material (Standard)' : '';
        btnTop.className = 'side-btn' + (s.additiveSide === 'top' ? ' active' : '');

        const btnBottom = document.createElement('button');
        btnBottom.type = 'button';
        btnBottom.textContent = 'Unten';
        btnBottom.title = faceEditContext ? 'Schneidet entlang der Flächen-/Ebenen-Normale (nach außen)' : '';
        btnBottom.className = 'side-btn' + (s.additiveSide === 'bottom' ? ' active' : '');

        const btnCenter = document.createElement('button');
        btnCenter.type = 'button';
        btnCenter.title = faceEditContext
          ? 'Tiefe wächst je zur Hälfte entlang und entgegen der Flächen-/Ebenen-Normale'
          : 'Tiefe wächst je zur Hälfte nach oben und unten aus der Skizzenebene heraus';
        btnCenter.textContent = 'Mittig';
        btnCenter.className = 'side-btn' + (s.additiveSide === 'center' ? ' active' : '');

        btnTop.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'top'; }); onShapesChanged(); });
        btnBottom.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'bottom'; }); onShapesChanged(); });
        btnCenter.addEventListener('click', () => { pushHistory(); shapesInGroup(s).forEach(sh => { sh.additiveSide = 'center'; }); onShapesChanged(); });

        depthRow.appendChild(btnTop);
        depthRow.appendChild(btnBottom);
        depthRow.appendChild(btnCenter);
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
document.getElementById('tool-polygon').addEventListener('click', () => setTool('polygon'));
document.getElementById('tool-heart').addEventListener('click', () => setTool('heart'));
document.getElementById('tool-text').addEventListener('click', () => setTool('text'));
document.getElementById('tool-holecircle').addEventListener('click', () => setTool('holecircle'));
document.getElementById('tool-splineprofile').addEventListener('click', () => setTool('splineprofile'));
document.getElementById('tool-select').addEventListener('click', () => setTool('select'));
document.getElementById('tool-lineselect').addEventListener('click', () => setTool('lineselect'));
document.getElementById('tool-dimension').addEventListener('click', () => setTool('dimension'));
document.getElementById('tool-origin').addEventListener('click', () => setTool('origin'));
document.getElementById('tool-point').addEventListener('click', () => setTool('point'));
document.getElementById('tool-centerpoint').addEventListener('click', () => setTool('centerpoint'));
document.getElementById('tool-edge').addEventListener('click', () => setTool('edge'));
document.getElementById('tool-alignline').addEventListener('click', () => setTool('alignline'));
document.getElementById('tool-edge3d').addEventListener('click', () => setTool('edge3d'));

updateToolShortcuts(); // reflect the initial tool ('line') before any button is clicked

// ===========================================================================
// Vielkeilprofil tool wiring: the panel (index.html #splineprofile-panel-block)
// doubles as both the "configure before placing" dialog (while currentTool
// === 'splineprofile', see the mousedown/render branches above) and the
// "edit an existing shape afterward" dialog (opened via the shape list's
// "Bearbeiten" button, see renderShapeList above) - splineProfileEditId picks
// which of the two modes is active and only changes what the primary button
// does and what it's labelled, everything else (fields, live status,
// quick-angle buttons) is shared.
// ===========================================================================

const splineProfileEls = {
  standard: document.getElementById('splineprofile-standard'),
  groupCustom: document.getElementById('splineprofile-group-custom'),
  groupDin5480: document.getElementById('splineprofile-group-din5480'),
  groupIso4156: document.getElementById('splineprofile-group-iso4156'),
  groupDin5481: document.getElementById('splineprofile-group-din5481'),
  groupIso14: document.getElementById('splineprofile-group-iso14'),
  shiftRow: document.getElementById('splineprofile-shift-row'),
  internalBtn: document.getElementById('splineprofile-mode-internal'),
  externalBtn: document.getElementById('splineprofile-mode-external'),
  centerX: document.getElementById('splineprofile-center-x'),
  centerY: document.getElementById('splineprofile-center-y'),
  teeth: document.getElementById('splineprofile-teeth'),
  module: document.getElementById('splineprofile-module'),
  pressureAngle: document.getElementById('splineprofile-pressure-angle'),
  dinReferenceDiameter: document.getElementById('splineprofile-din-reference-diameter'),
  dinModule: document.getElementById('splineprofile-din-module'),
  isoModule: document.getElementById('splineprofile-iso-module'),
  isoPressureAngle: document.getElementById('splineprofile-iso-pressure-angle'),
  din5481NominalDiameter: document.getElementById('splineprofile-din5481-nominal-diameter'),
  din5481TipDiameter: document.getElementById('splineprofile-din5481-tip-diameter'),
  din5481RootDiameter: document.getElementById('splineprofile-din5481-root-diameter'),
  din5481GapAngle: document.getElementById('splineprofile-din5481-gap-angle'),
  din5481TipFlat: document.getElementById('splineprofile-din5481-tip-flat'),
  din5481RootFlat: document.getElementById('splineprofile-din5481-root-flat'),
  iso14InnerDiameter: document.getElementById('splineprofile-iso14-inner-diameter'),
  iso14OuterDiameter: document.getElementById('splineprofile-iso14-outer-diameter'),
  iso14Width: document.getElementById('splineprofile-iso14-width'),
  iso14TipFlat: document.getElementById('splineprofile-iso14-tip-flat'),
  rotation: document.getElementById('splineprofile-rotation'),
  shift: document.getElementById('splineprofile-shift'),
  tipDiameter: document.getElementById('splineprofile-tip-diameter'),
  rootDiameter: document.getElementById('splineprofile-root-diameter'),
  rootFillet: document.getElementById('splineprofile-root-fillet'),
  status: document.getElementById('splineprofile-status'),
  apply: document.getElementById('btn-splineprofile-apply'),
  cancel: document.getElementById('btn-splineprofile-cancel'),
  panel: document.getElementById('splineprofile-panel-block'),
  computed: {
    pitchAngle: document.getElementById('splineprofile-computed-pitchangle'),
    pitch: document.getElementById('splineprofile-computed-pitch'),
    base: document.getElementById('splineprofile-computed-base'),
    tip: document.getElementById('splineprofile-computed-tip'),
    root: document.getElementById('splineprofile-computed-root'),
    circPitch: document.getElementById('splineprofile-computed-circpitch'),
    pressure: document.getElementById('splineprofile-computed-pressure'),
  },
};

// Reads the panel's current values into a plain params object (see
// computeSplineProfile/computeSerrationProfile/computeStraightSidedSplineProfile)
// - shared by the live preview and the apply handler so they can never
// disagree about what "the current settings" mean. The active Profilstandard
// (splineProfileEls.standard) only decides WHICH fields are read from and
// which generator computeSplineProfileForStandard() below dispatches to -
// the involute generator itself is standard-agnostic and untouched, and the
// two new straight-flank generators are equally standard-agnostic (see their
// own file comments).
function readSplineProfileParams() {
  const standard = splineProfileEls.standard.value;
  const common = {
    standard,
    standardVersion: null, // prepared for a future specific edition/year per standard - not used yet, see task scope
    internal: splineProfileEls.internalBtn.classList.contains('active'),
    centerX: parseFloat(splineProfileEls.centerX.value),
    centerY: parseFloat(splineProfileEls.centerY.value),
    teeth: parseFloat(splineProfileEls.teeth.value),
    rotation: parseFloat(splineProfileEls.rotation.value) || 0,
    rootFillet: parseFloat(splineProfileEls.rootFillet.value) || 0,
  };
  if (standard === 'din5480') {
    // DIN 5480: Zähnezahl + Bezugsdurchmesser are the two inputs, Modul is the
    // uniquely-determined dependent value (module = referenceDiameter / teeth)
    // - see the file note above computeSplineProfileForStandard() for why this
    // avoids two simultaneously-editable values that could disagree.
    const referenceDiameter = parseFloat(splineProfileEls.dinReferenceDiameter.value);
    const module = (Number.isFinite(referenceDiameter) && Number.isFinite(common.teeth) && common.teeth > 0)
      ? referenceDiameter / common.teeth : NaN;
    return {
      ...common,
      standardComplianceStatus: 'geometryOnly',
      profileShift: parseFloat(splineProfileEls.shift.value) || 0,
      referenceDiameter,
      module,
      pressureAngle: 30, // fixed by DIN 5480 - shown, not editable (see panel)
      tipDiameter: null, rootDiameter: null, // not offered for this standard - use the generator's own defaults
    };
  }
  if (standard === 'iso4156') {
    return {
      ...common,
      standardComplianceStatus: 'geometryOnly',
      profileShift: parseFloat(splineProfileEls.shift.value) || 0,
      module: parseFloat(splineProfileEls.isoModule.value),
      pressureAngle: parseFloat(splineProfileEls.isoPressureAngle.value),
      tipDiameter: null, rootDiameter: null, // not offered for this standard - use the generator's own defaults
    };
  }
  if (standard === 'din5481') {
    // DIN 5481 "Kerbverzahnung" - straight flanks, NOT an involute (see
    // computeSerrationProfile). profileGeometryType records which of the two
    // straight-flank generators produced the shape, mirroring how `standard`
    // records which panel/parameter set was used.
    return {
      ...common,
      standardComplianceStatus: 'geometryOnly',
      profileGeometryType: 'straightSerration',
      nominalDiameter: parseFloat(splineProfileEls.din5481NominalDiameter.value),
      tipDiameter: parseFloat(splineProfileEls.din5481TipDiameter.value),
      rootDiameter: parseFloat(splineProfileEls.din5481RootDiameter.value),
      flankAngle: parseFloat(splineProfileEls.din5481GapAngle.value), // "Lückenwinkel" - see field title
      tipFlat: parseFloat(splineProfileEls.din5481TipFlat.value) || 0,
      rootFlat: parseFloat(splineProfileEls.din5481RootFlat.value) || 0,
    };
  }
  if (standard === 'iso14') {
    // ISO 14 straight-sided spline - straight flanks, NOT an involute (see
    // computeStraightSidedSplineProfile).
    return {
      ...common,
      standardComplianceStatus: 'geometryOnly',
      profileGeometryType: 'straightSided',
      innerDiameter: parseFloat(splineProfileEls.iso14InnerDiameter.value),
      outerDiameter: parseFloat(splineProfileEls.iso14OuterDiameter.value),
      toothWidth: parseFloat(splineProfileEls.iso14Width.value),
      tipFlat: parseFloat(splineProfileEls.iso14TipFlat.value) || 0,
    };
  }
  return {
    ...common,
    standard: 'custom',
    standardComplianceStatus: 'custom',
    profileShift: parseFloat(splineProfileEls.shift.value) || 0,
    module: parseFloat(splineProfileEls.module.value),
    pressureAngle: parseFloat(splineProfileEls.pressureAngle.value),
    tipDiameter: parseFloat(splineProfileEls.tipDiameter.value) || null,
    rootDiameter: parseFloat(splineProfileEls.rootDiameter.value) || null,
  };
}

// Dispatches to whichever generator matches the active Profilstandard - the
// involute generator (computeSplineProfile) for custom/DIN 5480/ISO 4156, or
// one of the two straight-flank generators for DIN 5481/ISO 14 (see their
// file comments - deliberately NOT involutes, per task). Also adds a
// clearer, DIN-5480-specific message for the one involute failure mode
// that's otherwise hard to attribute (an empty/invalid Bezugsdurchmesser
// surfacing as a generic "Modul" error, even though Modul isn't an input
// field in that mode) - everything else is delegated unchanged.
function computeSplineProfileForStandard(params) {
  if (params.standard === 'din5480') {
    if (!Number.isFinite(params.referenceDiameter) || params.referenceDiameter <= 0) {
      return { points: null, filletRadii: null, error: 'Bezugsdurchmesser muss größer als 0 sein.', computed: null };
    }
    if (!Number.isFinite(params.module) || params.module <= 0) {
      return { points: null, filletRadii: null, error: 'Bezugsdurchmesser und Zähnezahl ergeben keinen gültigen Modul - beide Werte prüfen.', computed: null };
    }
  }
  if (params.standard === 'din5481') return computeSerrationProfile(params);
  if (params.standard === 'iso14') return computeStraightSidedSplineProfile(params);
  return computeSplineProfile(params);
}

// Shows only the field group relevant to the selected Profilstandard -
// values already typed into any group are left untouched (just hidden), so
// switching back and forth doesn't lose them. Profilverschiebung only
// applies to the involute-based standards (custom/DIN 5480/ISO 4156) - the
// two straight-flank standards have no such concept, so its row is hidden
// for those (per task: "Bei ISO 14 keine Profilverschiebung ... anzeigen").
function updateSplineProfileStandardGroups() {
  const standard = splineProfileEls.standard.value;
  splineProfileEls.groupCustom.style.display = standard === 'custom' ? 'block' : 'none';
  splineProfileEls.groupDin5480.style.display = standard === 'din5480' ? 'block' : 'none';
  splineProfileEls.groupIso4156.style.display = standard === 'iso4156' ? 'block' : 'none';
  splineProfileEls.groupDin5481.style.display = standard === 'din5481' ? 'block' : 'none';
  splineProfileEls.groupIso14.style.display = standard === 'iso14' ? 'block' : 'none';
  splineProfileEls.shiftRow.style.display = (standard === 'din5481' || standard === 'iso14') ? 'none' : 'block';
}
splineProfileEls.standard.addEventListener('change', () => {
  updateSplineProfileStandardGroups();
  ensureExplicitTipRootOrder();
  updateSplineProfileStatus();
});

// Corrects a pair of explicit tip/root diameter fields (only if BOTH are
// non-empty numbers - "automatisch"/blank fields are left alone, since the
// generators' own default formulas already account for internal/external)
// so they match the CURRENT Innen-/Außenverzahnung state: external needs
// tip > root, internal needs root > tip (addendum/dedendum are swapped - see
// computeSplineProfile/computeSerrationProfile). Without this, an explicit
// pair typed for one direction is silently invalid for the other, so the
// profile would simply stop rendering with only a small status message
// explaining why. Deliberately re-checked (not just swapped once on toggle)
// so it also self-corrects when the Profilstandard is switched while
// Innenverzahnung was already active from a previous standard - see both
// call sites below.
function ensureTipRootOrderFor(tipEl, rootEl, internal) {
  const tip = parseFloat(tipEl.value), root = parseFloat(rootEl.value);
  if (!Number.isFinite(tip) || !Number.isFinite(root)) return;
  const wrongOrder = internal ? !(root > tip) : !(tip > root);
  if (wrongOrder) {
    tipEl.value = root;
    rootEl.value = tip;
  }
}
function ensureExplicitTipRootOrder() {
  const internal = splineProfileEls.internalBtn.classList.contains('active');
  const standard = splineProfileEls.standard.value;
  if (standard === 'din5481') ensureTipRootOrderFor(splineProfileEls.din5481TipDiameter, splineProfileEls.din5481RootDiameter, internal);
  else if (standard === 'custom') ensureTipRootOrderFor(splineProfileEls.tipDiameter, splineProfileEls.rootDiameter, internal);
}

function setSplineProfileMode(internal) {
  splineProfileEls.externalBtn.classList.toggle('active', !internal);
  splineProfileEls.internalBtn.classList.toggle('active', internal);
  ensureExplicitTipRootOrder();
  updateSplineProfileStatus();
}
splineProfileEls.externalBtn.addEventListener('click', () => setSplineProfileMode(false));
splineProfileEls.internalBtn.addEventListener('click', () => setSplineProfileMode(true));

document.getElementById('splineprofile-angle-30').addEventListener('click', () => { splineProfileEls.pressureAngle.value = '30'; updateSplineProfileStatus(); });
document.getElementById('splineprofile-angle-375').addEventListener('click', () => { splineProfileEls.pressureAngle.value = '37.5'; updateSplineProfileStatus(); });
document.getElementById('splineprofile-angle-45').addEventListener('click', () => { splineProfileEls.pressureAngle.value = '45'; updateSplineProfileStatus(); });

// Re-validates the current panel values (without creating/changing anything)
// and shows a short message if they don't currently produce a valid profile -
// same idea as the in-canvas red-dashed error shape for a failed extrude,
// but for the not-yet-committed Vielkeilprofil panel. Also refreshes the
// DIN-5480 computed-Modul readout and the shared "Berechnete Werte" block.
function updateSplineProfileStatus() {
  const params = readSplineProfileParams();
  if (params.standard === 'din5480') {
    splineProfileEls.dinModule.value = Number.isFinite(params.module) ? roundForDisplay(params.module) : '';
  }
  const result = computeSplineProfileForStandard(params);
  splineProfileEls.status.textContent = result.error || '';
  const c = result.computed;
  splineProfileEls.computed.pitchAngle.textContent = c ? roundForDisplay(c.pitchAngleDeg) : '–';
  splineProfileEls.computed.pitch.textContent = c ? roundForDisplay(c.pitchDiameter) : '–';
  splineProfileEls.computed.base.textContent = c ? roundForDisplay(c.baseDiameter) : '–';
  splineProfileEls.computed.tip.textContent = c ? roundForDisplay(c.tipDiameter) : '–';
  splineProfileEls.computed.root.textContent = c ? roundForDisplay(c.rootDiameter) : '–';
  splineProfileEls.computed.circPitch.textContent = c ? roundForDisplay(c.circularPitch) : '–';
  splineProfileEls.computed.pressure.textContent = c ? roundForDisplay(c.pressureAngleDeg) : '–';
  render();
}
// Same rounding the rest of the sketch uses for on-canvas mm labels (see
// drawLiveLabel's toFixed(1) calls) - no new unit/rounding convention.
function roundForDisplay(v) {
  return Number.isFinite(v) ? v.toFixed(3).replace(/\.?0+$/, '') : '–';
}
[splineProfileEls.centerX, splineProfileEls.centerY, splineProfileEls.teeth, splineProfileEls.module,
 splineProfileEls.pressureAngle, splineProfileEls.dinReferenceDiameter, splineProfileEls.isoModule,
 splineProfileEls.din5481NominalDiameter, splineProfileEls.din5481TipDiameter, splineProfileEls.din5481RootDiameter,
 splineProfileEls.din5481GapAngle, splineProfileEls.din5481TipFlat, splineProfileEls.din5481RootFlat,
 splineProfileEls.iso14InnerDiameter, splineProfileEls.iso14OuterDiameter, splineProfileEls.iso14Width, splineProfileEls.iso14TipFlat,
 splineProfileEls.rotation, splineProfileEls.shift,
 splineProfileEls.tipDiameter, splineProfileEls.rootDiameter, splineProfileEls.rootFillet]
  .forEach(el => el.addEventListener('input', updateSplineProfileStatus));
splineProfileEls.isoPressureAngle.addEventListener('change', updateSplineProfileStatus);

// Shown while actively placing a new profile (currentTool === 'splineprofile')
// or editing an existing one (splineProfileEditId set) - see setTool() and
// openSplineProfileEditor()/closeSplineProfileEditor() below.
function updateSplineProfilePanelVisibility() {
  // A shape can be deleted (or undone) while its editor is open - drop the
  // stale reference instead of letting "Anwenden" silently do nothing/throw.
  if (splineProfileEditId != null && !shapes.some(s => s.id === splineProfileEditId)) {
    splineProfileEditId = null;
  }
  const show = currentTool === 'splineprofile' || splineProfileEditId != null;
  splineProfileEls.panel.style.display = show ? 'block' : 'none';
  if (!show) return;
  updateSplineProfileStandardGroups();
  const editing = splineProfileEditId != null;
  splineProfileEls.apply.textContent = editing ? '✓ Änderungen übernehmen' : '✓ Profil erstellen';
  splineProfileEls.cancel.textContent = editing ? '✕ Fertig' : '✕ Abbrechen';
  updateSplineProfileStatus();
}

// Opens the panel bound to an existing 'splineprofile' shape, pre-filled from
// its stored parameters (not re-derived from its baked points) - see the
// shape's `splineParams` field, set in the apply handler below. Shapes saved
// before the Profilstandard feature existed have no `standard` field at all -
// those are treated as 'custom' (see the datamodel note at the shape push
// below), matching how they always behaved.
function openSplineProfileEditor(shapeId) {
  const shape = shapes.find(s => s.id === shapeId);
  if (!shape || !shape.splineParams) return;
  const p = shape.splineParams;
  const standard = p.standard || 'custom';
  splineProfileEls.standard.value = standard;
  updateSplineProfileStandardGroups();
  setSplineProfileMode(!!p.internal);
  splineProfileEls.centerX.value = p.centerX;
  splineProfileEls.centerY.value = p.centerY;
  splineProfileEls.teeth.value = p.teeth;
  splineProfileEls.rotation.value = p.rotation;
  if (p.profileShift != null) splineProfileEls.shift.value = p.profileShift;
  splineProfileEls.rootFillet.value = p.rootFillet;
  if (standard === 'din5480') {
    splineProfileEls.dinReferenceDiameter.value = p.referenceDiameter != null ? p.referenceDiameter : p.module * p.teeth;
  } else if (standard === 'iso4156') {
    splineProfileEls.isoModule.value = p.module;
    splineProfileEls.isoPressureAngle.value = String(p.pressureAngle);
  } else if (standard === 'din5481') {
    splineProfileEls.din5481NominalDiameter.value = p.nominalDiameter;
    splineProfileEls.din5481TipDiameter.value = p.tipDiameter;
    splineProfileEls.din5481RootDiameter.value = p.rootDiameter;
    splineProfileEls.din5481GapAngle.value = p.flankAngle;
    splineProfileEls.din5481TipFlat.value = p.tipFlat || 0;
    splineProfileEls.din5481RootFlat.value = p.rootFlat || 0;
  } else if (standard === 'iso14') {
    splineProfileEls.iso14InnerDiameter.value = p.innerDiameter;
    splineProfileEls.iso14OuterDiameter.value = p.outerDiameter;
    splineProfileEls.iso14Width.value = p.toothWidth;
    splineProfileEls.iso14TipFlat.value = p.tipFlat || 0;
  } else {
    splineProfileEls.module.value = p.module;
    splineProfileEls.pressureAngle.value = p.pressureAngle;
    splineProfileEls.tipDiameter.value = p.tipDiameter || '';
    splineProfileEls.rootDiameter.value = p.rootDiameter || '';
  }
  splineProfileEditId = shapeId;
  updateSplineProfilePanelVisibility();
}

splineProfileEls.apply.addEventListener('click', () => {
  const params = readSplineProfileParams();
  const editing = splineProfileEditId != null;
  if (!editing && !splineProfileCenter) {
    splineProfileEls.status.textContent = 'Bitte zuerst einen Mittelpunkt in der Skizze anklicken.';
    return;
  }
  const result = computeSplineProfileForStandard(params);
  if (result.error) {
    splineProfileEls.status.textContent = result.error;
    return;
  }
  pushHistory();
  if (editing) {
    const shape = shapes.find(s => s.id === splineProfileEditId);
    if (shape) {
      shape.points = result.points;
      if (result.filletRadii) shape.filletRadii = result.filletRadii; else delete shape.filletRadii;
      shape.splineParams = params;
    }
    onShapesChanged();
    updateSplineProfilePanelVisibility();
  } else {
    const newId = nextShapeId++;
    shapes.push({
      id: newId, type: 'polygon', kind: 'splineprofile',
      points: result.points,
      filletRadii: result.filletRadii || undefined,
      splineParams: params,
      isHole: false, isAdditive: true, additiveHeight: 5, additiveSide: defaultAdditiveSide(), holeDepth: 5,
    });
    onShapesChanged();
    splineProfileCenter = null;
    setTool('select');
    selectedShapeIds = new Set([newId]);
    render();
  }
});

splineProfileEls.cancel.addEventListener('click', () => {
  if (splineProfileEditId != null) {
    splineProfileEditId = null;
    updateSplineProfilePanelVisibility();
  } else {
    setTool('select');
  }
});

btnInsertBgImage.addEventListener('click', () => {
  bgImageInput.value = '';
  bgImageInput.click();
});

bgImageInput.addEventListener('change', () => {
  const file = bgImageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => insertBackgroundImage(reader.result);
  reader.readAsDataURL(file);
});

// Drops a newly picked image into the sketch, centered in the current view and
// sized to fit comfortably within it (aspect ratio preserved) - then switches to
// the select tool with the new image selected so it's immediately movable/resizable.
function insertBackgroundImage(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const dpr = window.devicePixelRatio || 1;
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(canvas.width / dpr, canvas.height / dpr);
    const cx = (topLeft.x + bottomRight.x) / 2, cy = (topLeft.y + bottomRight.y) / 2;
    const aspect = img.naturalWidth / img.naturalHeight;
    let w = (bottomRight.x - topLeft.x) * 0.6, h = w / aspect;
    if (h > (bottomRight.y - topLeft.y) * 0.6) { h = (bottomRight.y - topLeft.y) * 0.6; w = h * aspect; }
    const rec = { id: nextBgImageId++, dataUrl, el: img, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
    backgroundImages.push(rec);
    selectedShapeIds.clear();
    selectedBgImageId = rec.id;
    setTool('select');
    markProjectDirty();
  };
  img.src = dataUrl;
}

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
  if (shapes.length > 0 || faceFeatures.length > 0 || edgeFillets.length > 0) markProjectDirty();
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  closePivotEditor(false);
  closeEdgeFilletEditor(false);
  endDrag();
  endBgImageDrag();
  endRotateDrag();
  faceSelectMode = false;
  faceEditContext = null;
  baseRollback = false;
  activeFeatureId = null;
  baseShapesStash = null;
  newPlaneMode = false;
  clearNewPlanePreview();
  selectedShapeIds.clear();
  selectedBgImageId = null;
  clearHoverHighlight();
  clearSelectedHighlight();
  clearHoverEdgeHighlight();
  clearSelectedEdgeHighlight();

  shapes = [];
  history = [];
  faceFeatures = [];
  edgeFillets = [];
  backgroundImages = [];
  nextShapeId = 1;
  nextFeatureId = 1;
  nextEdgeFilletId = 1;
  nextBgImageId = 1;

  if (extrudedGroup) {
    viewerScene.remove(extrudedGroup);
    extrudedGroup = null;
    meshVersion++;
    faceAdjacencyCache = null;
  }
  currentSolidForPicking = null;
  btnExport.disabled = true;
  btnExportStep.disabled = true;
  extrudeStatusEl.textContent = '';

  renderShapeList();
  renderEdgeFilletList();
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
// Converts the displayed number so the actual (mm) grid size is unchanged
// when switching units - only its display representation changes.
let previousGridUnit = gridUnitInput.value;
gridUnitInput.addEventListener('change', () => {
  const v = parseFloat(gridSizeInput.value);
  if (Number.isFinite(v)) {
    const converted = previousGridUnit === 'mm' && gridUnitInput.value === 'in' ? v / MM_PER_INCH
      : previousGridUnit === 'in' && gridUnitInput.value === 'mm' ? v * MM_PER_INCH
      : v;
    gridSizeInput.value = Math.round(converted * 10000) / 10000;
  }
  previousGridUnit = gridUnitInput.value;
  render();
});
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
  const pts = getOutlinePoints(shape);
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

// A prism-shaped Shape3D spanning [0, h] ('top'), [-h, 0] ('bottom'), or
// [-h/2, h/2] ('center', symmetric around the sketch plane) - 'top'/'bottom'
// overshoot slightly past Z=0 so a fuse/cut meeting exactly at the sketch
// plane isn't the classic ambiguous-coincident-face case (FEATURE_OVERSHOOT,
// see below); 'center' doesn't touch Z=0 with a face at all (it's the
// midpoint of one continuous prism, not a seam between two pieces), so it
// doesn't need that.
function replicadSidedSolid(shape, h, side) {
  const drawing = shapeToDrawing(shape, true);
  if (side === 'center') {
    const sketch = drawing.sketchOnPlane('XY', -h / 2);
    return sketch.extrude(h, { extrusionDirection: [0, 0, 1] });
  }
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
  // Open shapes (a line was deleted with "Linie auswählen" and not yet
  // re-closed) aren't closed regions, so they can't be extruded/cut - leave
  // them out of the solid until the line tool closes them again.
  const additives = shapes.filter(s => s.isAdditive && !s.open);
  const holes = shapes.filter(s => s.isHole && !s.open);
  if (additives.length === 0) return null;

  const material = new THREE.MeshStandardMaterial({ color: 0x8fb8ff, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide });

  let solid = null;
  additives.forEach(add => {
    const h = Math.max(0.01, parseFloat(add.additiveHeight) || 5);
    try {
      const piece = replicadSidedSolid(add, h, add.additiveSide);
      solid = solid ? solid.fuse(piece) : piece;
    } catch (err) {
      // Don't try to tag the caught value itself: OpenCascade/replicad failures
      // surface here as opaque WASM exceptions, which are frequently a bare
      // number or a non-extensible object rather than a real Error - silently
      // dropping `.failedShapeId` on those left rebuildSolid() with nothing to
      // highlight. Throwing our own Error instead guarantees the tag survives.
      console.error('replicadSidedSolid failed for shape', add.id, err);
      const tagged = new Error('extrude failed for shape ' + add.id);
      tagged.failedShapeId = add.id;
      throw tagged;
    }
  });
  holes.forEach(hole => {
    const d = Math.max(0.01, parseFloat(hole.holeDepth) || 5);
    try {
      solid = solid.cut(replicadSidedSolid(hole, d, hole.additiveSide));
    } catch (err) {
      console.error('replicadSidedSolid/cut failed for shape', hole.id, err);
      const tagged = new Error('extrude failed for shape ' + hole.id);
      tagged.failedShapeId = hole.id;
      throw tagged;
    }
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

// Builds {group, solid, material, warnings} for a given base-sketch shape list
// and face-feature list, purely computational (no viewer/DOM side effects) -
// the shared core behind both the authoritative "Übernehmen" rebuild
// (rebuildSolid) and the always-on live preview shown while editing (see
// scheduleLivePreview). Temporarily swaps the module-level `shapes` to
// `baseShapesSrc` for the duration of buildBaseGroup() (which reads it
// directly), restoring it immediately after - synchronous, so this is safe
// even while `shapes` currently points at a face feature's own sketch rather
// than the base one. Returns null if there's nothing to build yet (no closed
// additive shape in `baseShapesSrc`). Propagates buildBaseGroup()'s tagged
// exception (failedShapeId) on a bad profile, same as before this refactor.
function buildPreviewSolid(baseShapesSrc, featureList, includeFillets) {
  const savedShapes = shapes;
  shapes = baseShapesSrc;
  let base;
  try {
    base = buildBaseGroup();
  } finally {
    shapes = savedShapes;
  }
  if (!base) return null;

  const warnings = [];
  let finalGroup, finalSolid;
  if (featureList.length === 0) {
    finalGroup = base.group;
    finalSolid = base.solid;
  } else {
    const result = applyFaceFeaturesSubset(base.solid, base.material, featureList, warnings);
    finalGroup = result.group;
    finalSolid = result.solid;
  }
  // Edge fillets are always the very last step, applied on top of the base +
  // face features (see edgeFillets above/applyEdgeFillets) - re-mesh only if
  // there actually are any, no point re-triangulating an unfilletted solid.
  if (includeFillets && edgeFillets.length > 0) {
    finalSolid = applyEdgeFillets(finalSolid, edgeFillets, warnings);
    finalGroup = new THREE.Group();
    finalGroup.add(replicadShapeToMesh(finalSolid, base.material));
  }
  return { group: finalGroup, solid: finalSolid, material: base.material, warnings };
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
// position, into the running solid). This is the authoritative, "final" build -
// it reframes the camera and unlocks export, unlike the always-on live preview
// (see scheduleLivePreview) that keeps the viewer in sync while editing without
// doing either. Callable from the Übernehmen button directly, or via
// exitFaceEditMode() when that same button commits a face-edit sketch. Async
// because it awaits the WASM BREP kernel on first use.
async function rebuildSolid() {
  cancelLivePreview(); // this supersedes any pending live-preview rebuild
  baseRollback = false;
  extrudeStatusEl.textContent = 'BREP-Kernel wird geladen…';
  btnExtrude.disabled = true;
  await window.ocReadyPromise;
  btnExtrude.disabled = false;
  extrudeStatusEl.textContent = '';

  if (!viewerScene) initViewer();

  const hadErrorShape = errorShapeId != null;
  errorShapeId = null;

  let result;
  try {
    result = buildPreviewSolid(currentBaseSketch().shapes, faceFeatures, true);
  } catch (err) {
    // OpenCascade doesn't validate a sketch profile up front - a self-intersecting
    // outline (most often an over-bent curved line, see MAX_BULGE, or two shapes
    // overlapping in a way their boolean fuse/cut can't resolve) only surfaces here,
    // deep inside solid-building, as an opaque WASM exception with no useful message.
    // buildBaseGroup() tags the exception with the shape it was building when it blew
    // up (failedShapeId) so we can at least point at *a* likely culprit - not proof the
    // shape itself is invalid (a fuse/cut against an otherwise-fine neighbour can also
    // fail this way), but a much better starting point than "something, somewhere".
    // The previous (still valid) model, if any, is deliberately left alone in the viewer
    // rather than cleared, so a failed re-extrude doesn't also blank out the last good result.
    console.error('Extrusion fehlgeschlagen:', err);
    const idx = err.failedShapeId != null ? shapes.findIndex(s => s.id === err.failedShapeId) : -1;
    if (idx !== -1) {
      errorShapeId = err.failedShapeId;
      selectedShapeIds = new Set([err.failedShapeId]);
      extrudeStatusEl.textContent = `Extrusion fehlgeschlagen bei Form ${idx + 1} (${shapeLabel(shapes[idx])}, rot markiert in der Skizze) - vermutlich überschneidet sich ihre Kontur selbst (z.B. eine zu stark gebogene Linie). Form anpassen und erneut versuchen.`;
    } else {
      extrudeStatusEl.textContent = 'Extrusion fehlgeschlagen - vermutlich überschneidet sich eine Kontur selbst (z.B. eine zu stark gebogene Linie). Form anpassen und erneut versuchen.';
    }
    render();
    renderShapeList();
    updateFaceEditUI();
    return;
  }

  if (!result) {
    if (hadErrorShape) render();
    extrudeStatusEl.textContent = 'Keine geschlossene Form vorhanden.';
    updateFaceEditUI();
    return;
  }

  if (extrudedGroup) {
    viewerScene.remove(extrudedGroup);
    extrudedGroup = null;
  }

  viewerScene.add(result.group);
  extrudedGroup = result.group;
  currentSolidForPicking = result.solid;
  meshVersion++;
  faceAdjacencyCache = null;

  frameCameraToGroup(result.group);

  if (hadErrorShape) render();
  extrudeStatusEl.textContent = result.warnings.join(' ');
  btnExport.disabled = false;
  btnExportStep.disabled = false;
  modelCommitted = true;
  updateFaceEditUI();
  renderEdgeFilletList();
}

// ---- live 3D preview: keeps the viewer in sync with the sketch as changes
// are made, without an explicit "Übernehmen" click - Übernehmen (rebuildSolid /
// exitFaceEditMode) then only needs to lock the preview in (reframe the
// camera, unlock export, and - for a face feature - commit it into
// `faceFeatures` and leave edit mode). Debounced so a burst of edits (several
// quick clicks, or the end of a drag) coalesces into one rebuild instead of
// one per change; never called on every mousemove of an in-progress drag
// itself (see updateDrag/updatePointDrag), only once the drag ends via
// onShapesChanged() - continuous real-time preview during a drag would mean
// one BREP boolean rebuild per animation frame, far too slow for OpenCascade.
let livePreviewTimer = null;
const LIVE_PREVIEW_DEBOUNCE_MS = 250;

function cancelLivePreview() {
  if (livePreviewTimer) {
    clearTimeout(livePreviewTimer);
    livePreviewTimer = null;
  }
}

function scheduleLivePreview() {
  cancelLivePreview();
  livePreviewTimer = setTimeout(runLivePreview, LIVE_PREVIEW_DEBOUNCE_MS);
}

// Rebuilds and shows the 3D preview for whatever is currently being edited:
// - normally (no face edit, no rollback): the full end-of-history model, base
//   sketch + every committed face feature - same inputs as rebuildSolid, just
//   without reframing the camera or touching baseRollback/export-lock state,
//   so it can run continuously without being disruptive.
// - rolled back to the base sketch (see goToTimelineEntry): base sketch ONLY,
//   deliberately omitting face features - same reasoning as the old
//   showRollbackPreview() this replaces: they depend on geometry that's
//   currently being changed, so showing them would lie about the result.
// - editing a face/plane feature (see enterFaceEditMode): the real base
//   sketch (currentBaseSketch(), NOT the module-level `shapes`, which right
//   now IS the feature's own in-progress sketch) + every earlier committed
//   feature + this one's live, not-yet-committed shapes.
async function runLivePreview() {
  livePreviewTimer = null;
  await window.ocReadyPromise;
  if (!viewerScene) initViewer();

  const hadErrorShape = errorShapeId != null;
  errorShapeId = null;

  let baseShapesSrc, featureList, includeFillets;
  if (faceEditContext) {
    const idx = faceEditContext.featureId
      ? faceFeatures.findIndex((f) => f.id === faceEditContext.featureId)
      : faceFeatures.length;
    baseShapesSrc = currentBaseSketch().shapes;
    featureList = [...faceFeatures.slice(0, idx), { basis: faceEditContext.basis, shapes }];
    includeFillets = true;
  } else if (baseRollback) {
    baseShapesSrc = shapes;
    featureList = [];
    includeFillets = false;
  } else {
    baseShapesSrc = currentBaseSketch().shapes;
    featureList = faceFeatures;
    includeFillets = true;
  }

  let result;
  try {
    result = buildPreviewSolid(baseShapesSrc, featureList, includeFillets);
  } catch (err) {
    console.error('Live-Vorschau fehlgeschlagen:', err);
    const idx2 = err.failedShapeId != null ? shapes.findIndex((s) => s.id === err.failedShapeId) : -1;
    if (idx2 !== -1) {
      errorShapeId = err.failedShapeId;
      selectedShapeIds = new Set([err.failedShapeId]);
      extrudeStatusEl.textContent = `Vorschau fehlgeschlagen bei Form ${idx2 + 1} (${shapeLabel(shapes[idx2])}, rot markiert in der Skizze) - vermutlich überschneidet sich ihre Kontur selbst (z.B. eine zu stark gebogene Linie).`;
    } else {
      extrudeStatusEl.textContent = 'Vorschau fehlgeschlagen - vermutlich überschneidet sich eine Kontur selbst (z.B. eine zu stark gebogene Linie).';
    }
    render();
    renderShapeList();
    updateFaceEditUI();
    return;
  }

  if (!result) {
    // Nothing valid to show yet (e.g. sketch has no closed additive shape) -
    // leave whatever preview is already on screen alone rather than blanking
    // it, same "don't discard the last good result" principle as rebuildSolid.
    if (hadErrorShape) render();
    extrudeStatusEl.textContent = 'Keine geschlossene Form vorhanden.';
    updateFaceEditUI();
    return;
  }

  if (extrudedGroup) viewerScene.remove(extrudedGroup);
  viewerScene.add(result.group);
  extrudedGroup = result.group;
  currentSolidForPicking = result.solid;
  meshVersion++;
  faceAdjacencyCache = null;

  if (hadErrorShape) render();
  extrudeStatusEl.textContent = result.warnings.join(' ');
  btnExport.disabled = false;
  btnExportStep.disabled = false;
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
//
// `flipV` (returned alongside u/v/normal): the 2D canvas is Y-down (larger
// model-y draws lower on screen, see worldToScreen), so for the mapping to
// feel right, moving DOWN on the canvas must move geometry DOWN in the world
// too - i.e. vAxis (the world direction the canvas's +y points along) has to
// point "down-ish", not "up-ish". The raw cross-product vAxis always comes
// out pointing up-ish instead, so it usually needs negating:
//   - Sloped/vertical (wall) faces: the un-negated vAxis = n × uAxis always
//     has a non-negative Z component (its Z is 1 - n.z^2 >= 0), i.e. it points
//     up. Without correction, a circle drawn at the top of the 2D sketch
//     extrudes at the BOTTOM of the wall in 3D (and vice versa). So these
//     always flip.
//   - Top face (normal ~ +Z): the flat base profile, whose own y was already
//     negated by shapeToDrawing when placed on world XY, reads back with
//     world Y = -(shape y); flipping here restores the original orientation so
//     re-sketching on it isn't upside down. Flips.
//   - Bottom face (normal ~ -Z, the underside): crossing the (already -Z)
//     normal into uAxis flips vAxis on its own, which happens to already
//     cancel the base sketch's flip - viewed from below, that's the correct
//     (mirrored) orientation. Does NOT flip.
// extrudeFaceShape applies the matching y-negation when actually building a
// shape's profile on this basis (see its own flipV usage) - vAxis here and
// that compensation must always agree, or a sketch's on-screen reference and
// where it actually extrudes to would disagree with each other instead.
function buildFaceBasis(normal, origin) {
  const n = normal.clone().normalize();
  const worldUp = new THREE.Vector3(0, 0, 1);
  const isNearVertical = Math.abs(n.dot(worldUp)) > 0.999;
  const uAxis = isNearVertical
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3().crossVectors(worldUp, n).normalize();
  // Flip for everything except the underside (bottom) face - see the cases in
  // the comment above.
  const flipV = isNearVertical ? n.z > 0 : true;
  const vAxis = new THREE.Vector3().crossVectors(n, uAxis).normalize();
  if (flipV) vAxis.negate();
  return { origin: origin.clone(), normal: n, uAxis, vAxis, flipV };
}

function worldToUV(p, basis) {
  const rel = new THREE.Vector3().subVectors(p, basis.origin);
  return { x: rel.dot(basis.uAxis), y: rel.dot(basis.vAxis) };
}

// ---- free-standing "new plane" (datum plane) basis + preview ----------------

const WORLD_AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const AXIS_ORDER = ['x', 'y', 'z'];

// Builds a basis (same shape as buildFaceBasis's result) for a user-defined
// datum plane: `axis` picks the un-tilted normal direction (one of the 3
// standard planes - x -> YZ, y -> XZ, z -> XY), `offsetMm` places its origin
// that far along that axis from the world origin, and `angleDeg` tilts the
// plane by rotating around a fixed reference axis lying in the plane itself
// (cyclic: x-normal tilts around y, y-normal around z, z-normal around x) -
// so "Achse" first picks a base plane, then "Winkel" hinges it, both pivoting
// through the same point set by "Koordinate".
//
// The normal always starts out pointing in the *positive* axis direction,
// regardless of `offsetMm`'s sign - so a plane placed at e.g. Koordinate=-30
// (the "far" side of a part centered on the origin) still gets a normal
// pointing toward +axis, i.e. INTO the part rather than away from it. Since
// "Aufaddieren"/"Loch" always add/cut along -overshoot..h / -d..+overshoot
// relative to that normal (see extrudeFaceShape), a wrong-way normal there
// means a boss grows into the part (usually still visible, just oddly placed)
// while a hole cuts almost entirely into empty space beyond the part (only
// the thin FEATURE_OVERSHOOT sliver actually touches it) - looking like
// nothing happened. `flip` (the "Richtung umkehren" checkbox) negates the
// normal (and vAxis, to stay a consistent right-handed frame - uAxis is the
// tilt hinge and is unaffected either way) to fix that.
function computeCustomPlaneBasis(axis, offsetMm, angleDeg, flip) {
  const i = AXIS_ORDER.indexOf(axis);
  const normal0 = WORLD_AXES[AXIS_ORDER[i]].clone();
  const uAxis = WORLD_AXES[AXIS_ORDER[(i + 1) % 3]].clone();
  const vAxis0 = new THREE.Vector3().crossVectors(normal0, uAxis).normalize();
  const origin = normal0.clone().multiplyScalar(offsetMm || 0);
  const angleRad = ((parseFloat(angleDeg) || 0) * Math.PI) / 180;
  const normal = normal0.clone().applyAxisAngle(uAxis, angleRad).normalize();
  const vAxis = vAxis0.applyAxisAngle(uAxis, angleRad).normalize();
  if (flip) {
    normal.negate();
    vAxis.negate();
  }
  // Same canvas Y-down correction as buildFaceBasis's near-vertical case: a
  // datum plane parallel to the base XY sketch plane (normal pointing "up",
  // i.e. +Z, same as the default/most common "Neue Ebene") must use the same
  // flipV convention the base sketch itself uses, or its modelReferenceUV
  // (the existing model's edges, projected via worldToUV) shows vertically
  // mirrored relative to what a fresh sketch on it actually builds (see
  // buildFaceBasis's own comment for the full explanation).
  const worldUp = new THREE.Vector3(0, 0, 1);
  const isNearVertical = Math.abs(normal.dot(worldUp)) > 0.999;
  const flipV = isNearVertical && normal.z > 0;
  if (flipV) vAxis.negate();
  return { origin, normal, uAxis, vAxis, flipV };
}

const NEW_PLANE_PREVIEW_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x5fd06b, transparent: true, opacity: 0.28, depthTest: true, side: THREE.DoubleSide });
const NEW_PLANE_PREVIEW_EDGE_MATERIAL = new THREE.LineBasicMaterial({ color: 0x5fd06b });

// Picks a reasonable preview plane size: big enough to visibly span the
// current model, with a sane fallback before anything has been extruded yet.
function newPlanePreviewSize() {
  if (extrudedGroup) {
    const diag = new THREE.Box3().setFromObject(extrudedGroup).getSize(new THREE.Vector3()).length();
    if (diag > 1e-6) return Math.max(diag * 0.9, 60);
  }
  return 150;
}

// (Re)draws the translucent plane + normal arrow overlay in the 3D viewer for
// the currently configured datum plane, so the user can see where it would
// land before committing - called on every axis/offset/angle change.
function updateNewPlanePreview() {
  clearNewPlanePreview();
  if (!newPlaneMode || !viewerScene) return;
  const basis = computeCustomPlaneBasis(newPlaneConfig.axis, newPlaneConfig.offset, newPlaneConfig.angle, newPlaneConfig.flip);
  const size = newPlanePreviewSize();
  const group = new THREE.Group();

  const geometry = new THREE.PlaneGeometry(size, size);
  group.add(new THREE.Mesh(geometry, NEW_PLANE_PREVIEW_MATERIAL));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), NEW_PLANE_PREVIEW_EDGE_MATERIAL));
  group.add(new THREE.ArrowHelper(basis.normal, new THREE.Vector3(0, 0, 0), size * 0.25, 0x5fd06b, size * 0.05, size * 0.03));

  group.position.copy(basis.origin);
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(basis.uAxis, basis.vAxis, basis.normal));

  viewerScene.add(group);
  newPlanePreviewGroup = group;
}

function clearNewPlanePreview() {
  if (!newPlanePreviewGroup) return;
  if (viewerScene) viewerScene.remove(newPlanePreviewGroup);
  newPlanePreviewGroup.traverse((obj) => { if (obj.geometry) obj.geometry.dispose(); });
  newPlanePreviewGroup = null;
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
// `basis.flipV` (see buildFaceBasis) mirrors the same y-negation the base
// sketch itself uses, so the actual 3D placement agrees with the basis's own
// vAxis/worldToUV - without it, a "top"-facing pick's reference outline would
// show right-side-up while a fresh sketch on it actually built upside-down.
function extrudeFaceShape(shape, basis, alongNormalFrom, alongNormalTo) {
  const drawing = shapeToDrawing(shape, !!basis.flipV);
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

// Computes [alongNormalFrom, alongNormalTo] (see extrudeFaceShape) for a
// face/plane feature's boss ('isAdditive', amount = additiveHeight) or
// pocket (amount = holeDepth), given its own `side` - the same
// 'top'/'bottom'/'center' choice as a base-sketch shape's additiveSide, just
// relative to the feature's own basis normal instead of world Z:
// - 'top' (default, matches every feature saved before this option existed):
//   a boss grows outward along +normal, a pocket cuts inward against it
//   (along -normal) - unchanged from before.
// - 'bottom': the reverse of 'top' along the same axis.
// - 'center': split evenly both ways around the feature's own plane - like
//   replicadSidedSolid's 'center', this doesn't need the overshoot since it
//   isn't meeting the plane with a face, just passing through its middle.
function faceFeatureExtrudeRange(amount, side, isAdditive) {
  if (side === 'center') return [-amount / 2, amount / 2];
  const reversed = side === 'bottom';
  if (isAdditive) return reversed ? [-amount, FEATURE_OVERSHOOT] : [-FEATURE_OVERSHOOT, amount];
  return reversed ? [-FEATURE_OVERSHOOT, amount] : [-amount, FEATURE_OVERSHOOT];
}

// Starting from `baseSolid` (the already-built base sketch, a replicad
// Shape3D), replays each given face feature in creation order: extrude each
// of its shapes (additive -> fuse boss, hole -> cut pocket) along the
// feature's stored basis - the exact plane it was originally sketched on -
// and fold it into the solid. `featureList` is a prefix of (or the full)
// `faceFeatures`, so this also powers the live preview shown while a feature
// is being (re-)edited (see runLivePreview).
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
          const [from, to] = faceFeatureExtrudeRange(h, s.additiveSide, true);
          solid = solid.fuse(extrudeFaceShape(s, basis, from, to));
        } else {
          const d = Math.max(0.01, parseFloat(s.holeDepth) || 5);
          const [from, to] = faceFeatureExtrudeRange(d, s.additiveSide, false);
          solid = solid.cut(extrudeFaceShape(s, basis, from, to));
        }
      } catch (err) {
        warnings.push(`Feature #${idx + 1} konnte nicht angewendet werden, übersprungen.`);
      }
    });
  });

  const group = new THREE.Group();
  group.add(replicadShapeToMesh(solid, material));
  return { group, solid };
}

function applyFaceFeatures(baseSolid, material, warnings) {
  return applyFaceFeaturesSubset(baseSolid, material, faceFeatures, warnings);
}

// ---- 3D edge fillets: geometry helpers ---------------------------------------

// Samples an edge's curve into `n` world-space points (replicad's Edge.pointAt()
// is normalized 0..1 across the curve's own parameter range - straight or curved,
// closed or not) - used for picking, re-matching across rebuilds, and highlighting.
function sampleEdgePoints(edge, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const v = edge.pointAt(i / n);
    pts.push({ x: v.x, y: v.y, z: v.z });
  }
  return pts;
}

// More samples for longer/curved edges (so a big fillet's own rounded edges or a
// large circular edge still get enough points), fewer for short straight ones.
function edgeSampleCount(edge) {
  let len = 0;
  try { len = edge.length; } catch (err) { /* degenerate edge - fall through with len=0 */ }
  return Math.max(6, Math.min(48, Math.round(len / 2) + 6));
}

// Projects every real BREP edge of `solid` onto `basis` as an array of open UV
// polylines - a flattened wireframe "footprint" of the model, used as a
// sketch-plane reference for free-standing datum planes (see
// computeCustomPlaneBasis / drawFaceReferenceOutline) that have no picked
// face of their own to show a boundary for.
function projectSolidEdgesToUV(solid, basis) {
  if (!solid) return [];
  let edges;
  try { edges = solid.edges; } catch (err) { return []; }
  return edges.map((edge) => sampleEdgePoints(edge, edgeSampleCount(edge)).map((p) => worldToUV(new THREE.Vector3(p.x, p.y, p.z), basis)));
}

// Finds whichever edge of `solid` passes closest to world-space `point` - used
// both to re-identify a stored fillet's edge on a freshly rebuilt solid (see
// applyEdgeFillets) and, from the 3D-edge tool, to find the edge nearest a
// raycast hit (see pickEdgeForViewerEvent). Plain nearest-sample-point search
// rather than exact BREP identity: robust across rebuilds since a rebuilt solid
// is geometrically identical (deterministic replay of the same operations) even
// though every Edge wrapper is a brand new JS/OCC object each time.
function findNearestEdge(solid, point) {
  let best = null, bestDist = Infinity;
  let edges;
  try { edges = solid.edges; } catch (err) { return null; }
  edges.forEach((edge) => {
    sampleEdgePoints(edge, edgeSampleCount(edge)).forEach((p) => {
      const d = Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z);
      if (d < bestDist) { bestDist = d; best = edge; }
    });
  });
  return best;
}

// Applies every stored edge fillet in order, each re-identified on the current
// (in-progress) solid by the world-space point it was picked at - same "fixed
// position, doesn't chase the surface" approach as face features (see
// applyFaceFeaturesSubset): a filletted edge is consumed by the operation
// (replaced with a new rounded face and two new edges), so there's no lasting
// identity to track anyway, only where it used to be.
function applyEdgeFillets(solid, filletList, warnings) {
  filletList.forEach((f, idx) => {
    const edge = findNearestEdge(solid, f.point);
    if (!edge) {
      warnings.push(`Kantenrundung #${idx + 1}: Kante nicht mehr gefunden, übersprungen.`);
      return;
    }
    try {
      solid = solid.fillet(f.radius, (finder) => {
        finder.filters.push(({ element }) => element.isSame(edge));
        return finder;
      });
    } catch (err) {
      console.error('Kantenrundung fehlgeschlagen:', err);
      warnings.push(`Kantenrundung #${idx + 1} (R${f.radius} mm) konnte nicht angewendet werden (Radius evtl. zu groß für diese Kante), übersprungen.`);
    }
  });
  return solid;
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

// ---- 3D edge fillets: picking + highlight ------------------------------------

const EDGE_PICK_PX = 10;
const EDGE_HOVER_MATERIAL = new THREE.LineBasicMaterial({ color: 0x4a7dfc });
const EDGE_SELECTED_MATERIAL = new THREE.LineBasicMaterial({ color: 0xffcc55 });

function projectToScreen(x, y, z, rect) {
  const p = new THREE.Vector3(x, y, z).project(viewerCamera);
  return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height };
}

// Finds the solid edge nearest the cursor for the 3D-edge tool. First raycasts
// against the mesh to get a depth-correct visible surface point (so picking is
// judged against whatever's actually in front, not occluded geometry the mouse
// happens to line up with), then finds whichever real BREP edge on
// `currentSolidForPicking` passes closest to that point in 3D. Finally confirms
// the cursor is genuinely near that edge on screen (in pixels) - without this,
// clicking the middle of a large flat face would always snap to whatever edge
// happens to be nearest, however far away, instead of correctly missing.
function pickEdgeForViewerEvent(evt) {
  if (!currentSolidForPicking) return null;
  const hit = raycastViewer(evt);
  if (!hit) return null;
  const edge = findNearestEdge(currentSolidForPicking, hit.point);
  if (!edge) return null;
  const samples = sampleEdgePoints(edge, edgeSampleCount(edge));
  const rect = viewerRenderer.domElement.getBoundingClientRect();
  const mx = evt.clientX - rect.left, my = evt.clientY - rect.top;
  let bestPx = Infinity;
  samples.forEach((p) => {
    const sp = projectToScreen(p.x, p.y, p.z, rect);
    bestPx = Math.min(bestPx, Math.hypot(sp.x - mx, sp.y - my));
  });
  if (bestPx > EDGE_PICK_PX) return null;
  const mid = edge.pointAt(0.5);
  return { edge, samples, point: { x: mid.x, y: mid.y, z: mid.z } };
}

function buildEdgeHighlightLine(samples, material) {
  const points = samples.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.Line(geometry, material);
}

function clearHoverEdgeHighlight() {
  if (hoverEdgeHighlight) {
    viewerScene.remove(hoverEdgeHighlight);
    hoverEdgeHighlight.geometry.dispose();
    hoverEdgeHighlight = null;
  }
}

function clearSelectedEdgeHighlight() {
  if (selectedEdgeHighlight) {
    viewerScene.remove(selectedEdgeHighlight);
    selectedEdgeHighlight.geometry.dispose();
    selectedEdgeHighlight = null;
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
  if (faceSelectMode) {
    const hit = raycastViewer(evt);
    if (!hit) return;
    const result = getFaceRegionForHit(hit);
    if (!result) return;
    faceSelectMode = false;
    clearHoverHighlight();
    if (faceSelectPurpose === 'exportDxf') {
      // No lasting selection highlight / edit mode - just grab the outline
      // and download it, leaving the model exactly as it was.
      updateFaceEditUI();
      exportFaceAsDxf(result);
      return;
    }
    const adj = getOrBuildAdjacency(hit.object);
    clearSelectedHighlight();
    selectedFaceHighlight = new THREE.Mesh(buildHighlightGeometry(adj, result.triIndices, result.basis.normal), HIGHLIGHT_MATERIAL_SELECTED);
    viewerScene.add(selectedFaceHighlight);
    enterFaceEditMode(result);
    return;
  }
  if (currentTool === 'edge3d' && !faceEditContext && !baseRollback && !newPlaneMode) {
    if (edgeFilletEditor) { closeEdgeFilletEditor(true); return; } // clicking elsewhere applies the pending one first
    const pick = pickEdgeForViewerEvent(evt);
    if (!pick) return;
    clearHoverEdgeHighlight();
    clearSelectedEdgeHighlight();
    selectedEdgeHighlight = buildEdgeHighlightLine(pick.samples, EDGE_SELECTED_MATERIAL);
    viewerScene.add(selectedEdgeHighlight);
    openEdgeFilletEditor(pick);
  }
}

function onViewerPointerMove(evt) {
  if (faceSelectMode) {
    const hit = raycastViewer(evt);
    if (!hit) { clearHoverHighlight(); return; }
    const adj = getOrBuildAdjacency(hit.object);
    const region = floodFillCoplanarRegion(adj, hit.faceIndex);
    if (!region) { clearHoverHighlight(); return; }
    clearHoverHighlight();
    hoverFaceHighlight = new THREE.Mesh(buildHighlightGeometry(adj, region.triIndices, region.normal), HIGHLIGHT_MATERIAL_HOVER);
    viewerScene.add(hoverFaceHighlight);
    return;
  }
  if (currentTool === 'edge3d' && !faceEditContext && !baseRollback && !newPlaneMode && !edgeFilletEditor) {
    const pick = pickEdgeForViewerEvent(evt);
    if (!pick) { clearHoverEdgeHighlight(); viewerRenderer.domElement.style.cursor = 'auto'; return; }
    clearHoverEdgeHighlight();
    hoverEdgeHighlight = buildEdgeHighlightLine(pick.samples, EDGE_HOVER_MATERIAL);
    viewerScene.add(hoverEdgeHighlight);
    viewerRenderer.domElement.style.cursor = 'pointer';
  }
}

// Floating radius-input popup for a just-picked 3D edge, styled and wired the
// same way as the 2D corner-fillet editor (openFilletEditor) - Enter/blur
// applies, Escape cancels. Positioned over the 3D viewer at the edge's own
// midpoint (projected to screen), appended to #view-pane (not #viewer) since
// that's the nearest positioned ancestor - see .pane in style.css - matching
// how #face-select-hint is positioned there too.
function openEdgeFilletEditor(pick) {
  closeEdgeFilletEditor(false);
  const rect = viewerRenderer.domElement.getBoundingClientRect();
  const screenPos = projectToScreen(pick.point.x, pick.point.y, pick.point.z, rect);
  const canvasEl = viewerRenderer.domElement;

  const wrap = document.createElement('div');
  wrap.className = 'dim-editor-wrap';
  wrap.style.left = (canvasEl.offsetLeft + screenPos.x) + 'px';
  wrap.style.top = (canvasEl.offsetTop + screenPos.y) + 'px';

  const label = document.createElement('span');
  label.className = 'dim-anchor-btn';
  label.style.cursor = 'default';
  label.title = 'Rundungsradius (Fillet) für diese 3D-Kante';
  label.textContent = '⌒';
  wrap.appendChild(label);

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'dim-editor';
  input.step = '0.1';
  input.min = '0.1';
  input.placeholder = '2';
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') closeEdgeFilletEditor(true);
    else if (e.key === 'Escape') closeEdgeFilletEditor(false);
  });
  input.addEventListener('blur', () => closeEdgeFilletEditor(true));
  wrap.appendChild(input);

  document.getElementById('view-pane').appendChild(wrap);
  edgeFilletEditor = { input, wrap, point: pick.point };
  input.focus();
}

function closeEdgeFilletEditor(apply) {
  if (!edgeFilletEditor) return;
  const { input, wrap, point } = edgeFilletEditor;
  edgeFilletEditor = null; // clear first so the blur triggered by remove() below doesn't recurse
  if (apply) {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0) {
      edgeFillets.push({ id: nextEdgeFilletId++, point, radius: val });
      onEdgeFilletsChanged();
    }
  }
  wrap.remove();
  clearSelectedEdgeHighlight();
}

function onEdgeFilletsChanged() {
  markProjectDirty();
  renderEdgeFilletList();
  rebuildSolid();
}

function deleteEdgeFillet(id) {
  edgeFillets = edgeFillets.filter(f => f.id !== id);
  onEdgeFilletsChanged();
}

function renderEdgeFilletList() {
  const panel = document.getElementById('edge-fillet-panel-block');
  const list = document.getElementById('edge-fillet-list');
  if (!panel || !list) return;
  panel.style.display = edgeFillets.length ? 'block' : 'none';
  list.innerHTML = '';
  edgeFillets.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'shape-item';

    const row = document.createElement('div');
    row.className = 'shape-item-row';
    const label = document.createElement('span');
    label.textContent = `${idx + 1}. Kante R${f.radius} mm`;
    row.appendChild(label);

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Kantenrundung entfernen';
    delBtn.addEventListener('click', () => deleteEdgeFillet(f.id));
    row.appendChild(delBtn);

    item.appendChild(row);
    list.appendChild(item);
  });
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

// The base sketch's own {shapes, backgroundImages}, regardless of whether
// `shapes`/`backgroundImages` currently hold the base's data or some other
// feature's - reads straight through only when the base IS what's loaded
// there (no feature is being live-edited AND none is the active display
// target, see faceEditContext/activeFeatureId), or the stashed copy
// otherwise. `shapes` is NEVER the base while faceEditContext is set (it's
// always been swapped to the feature's own sketch by then, however
// activeFeatureId itself only gets updated once that edit ends - see
// enterFaceEditMode/exitFaceEditMode), so that has to be checked too, not
// just activeFeatureId. Used anywhere that needs "the real base sketch"
// specifically: building the base solid (rebuildSolid/runLivePreview) and
// saving a project.
function currentBaseSketch() {
  return (!faceEditContext && activeFeatureId === null) ? { shapes, backgroundImages } : baseShapesStash;
}

// True while enterFaceEditMode() is (re-)locating an existing feature's face
// on the rolled-back solid - guards against a second click re-entering
// before faceEditContext is set (see enterFaceEditMode).
// Swaps the module-level `shapes`/`history` to a face feature's own sketch
// (new, empty for a brand-new feature, or a previously-saved one when
// re-editing), stashing whatever was displayed before (the base sketch, or
// another feature - see activeFeatureId) to restore on "Abbrechen". All
// in-progress drawing/editor state is force-reset rather than preserved
// across the switch, matching the existing pattern setTool() already uses
// for tool changes.
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
  endBgImageDrag();
  endRotateDrag();
  selectedShapeIds.clear();
  selectedBgImageId = null;
  baseRollback = false;

  const existingIdx = pick.featureId ? faceFeatures.findIndex((f) => f.id === pick.featureId) : -1;
  const existing = existingIdx >= 0 ? faceFeatures[existingIdx] : null;

  // Leaving the base sketch for the first time (it's not already stashed
  // because some other feature was active) - stash it now so it survives
  // even if we end up staying on a feature's sketch past this edit (see
  // exitFaceEditMode). If another feature was already active instead, its
  // data lives on as that feature's own `.shapes`/`.backgroundImages` (see
  // exitFaceEditMode's commit branch), so there's nothing to stash for it.
  if (activeFeatureId === null) baseShapesStash = { shapes, backgroundImages };

  faceEditContext = {
    featureId: pick.featureId || null,
    basis: pick.basis,
    boundaryLoopUV: pick.boundaryLoopUV,
    innerLoopsUV: pick.innerLoopsUV || [],
    modelReferenceUV: pick.modelReferenceUV || [],
    previousShapes: shapes,
    previousHistory: history,
    previousBackgroundImages: backgroundImages,
    previousActiveFeatureId: activeFeatureId,
  };

  // Deep-clone so in-place edits (dragging a point, changing a length, adding
  // a shape) don't leak into the stored feature until "Übernehmen" actually
  // commits `shapes` back onto it - otherwise "Abbrechen" couldn't undo them
  // (the live preview shown in the meantime reads the live `shapes` directly,
  // see runLivePreview, so it stays in sync without needing this clone touched).
  shapes = existing ? JSON.parse(JSON.stringify(existing.shapes)) : [];
  history = [];
  // Shallow-clone (not deep, unlike shapes above) since each entry carries a
  // loaded HTMLImageElement in `el` that JSON.stringify can't round-trip -
  // "Abbrechen" only needs to discard position/size edits, not the image itself.
  backgroundImages = existing ? (existing.backgroundImages || []).map(bg => ({ ...bg })) : [];

  // A picked face fits to its own boundary; a free-standing datum plane has
  // none (boundaryLoopUV is empty), so fit to the projected model reference
  // wireframe instead - fitViewToLoop only reads point x/y, it doesn't care
  // whether they form one closed loop or come from many separate edges.
  const fitPoints = (pick.boundaryLoopUV && pick.boundaryLoopUV.length) ? pick.boundaryLoopUV : (pick.modelReferenceUV || []).flat();
  fitViewToLoop(fitPoints);
  renderShapeList();
  updateFaceEditUI();
  render();

  // Immediately show this feature's own state (base + earlier features + this
  // one's - possibly pre-existing - shapes), rather than waiting for the
  // debounce or the first edit (see runLivePreview).
  cancelLivePreview();
  runLivePreview();
}

function exitFaceEditMode(commit) {
  if (!faceEditContext) return;
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  closePivotEditor(false);
  endDrag();
  endBgImageDrag();
  endRotateDrag();
  selectedShapeIds.clear();
  selectedBgImageId = null;

  const ctx = faceEditContext;
  let committedFeatureId = null;
  if (commit) {
    if (ctx.featureId) {
      const f = faceFeatures.find((x) => x.id === ctx.featureId);
      f.shapes = shapes;
      f.backgroundImages = backgroundImages;
      committedFeatureId = f.id;
    } else {
      const f = {
        id: nextFeatureId++,
        basis: ctx.basis,
        boundaryLoopUV: ctx.boundaryLoopUV,
        innerLoopsUV: ctx.innerLoopsUV,
        modelReferenceUV: ctx.modelReferenceUV,
        shapes: shapes,
        backgroundImages: backgroundImages,
      };
      faceFeatures.push(f);
      committedFeatureId = f.id;
    }
    markProjectDirty();
  }

  if (commit) {
    // "Übernehmen" locks the sketch into faceFeatures but keeps it the
    // active/editable one in the 2D view - matching how the base sketch has
    // always stayed directly editable after any change, instead of jumping
    // back to the base automatically. `shapes`/`history`/`backgroundImages`
    // already ARE this feature's own live data (same references just saved
    // onto it above), so there's nothing to swap here.
    activeFeatureId = committedFeatureId;
  } else {
    // "Abbrechen": discard this edit, go back to whatever was displayed
    // before it started (the base sketch, or another feature).
    shapes = ctx.previousShapes;
    history = ctx.previousHistory;
    backgroundImages = ctx.previousBackgroundImages;
    activeFeatureId = ctx.previousActiveFeatureId;
  }
  faceEditContext = null;
  clearSelectedHighlight();
  clearHoverHighlight();
  renderShapeList();

  // Whether committed or cancelled, the 3D model always jumps back to the
  // end of the timeline: rebuild from the base sketch through every feature
  // (using the just-saved shapes when committed, the untouched feature
  // otherwise), replacing the temporary rollback preview. Which sketch stays
  // open in the 2D view (see activeFeatureId above) is independent of this.
  rebuildSolid();
  render();
}

function reopenFaceFeature(id) {
  if (faceEditContext || faceSelectMode || newPlaneMode) return;
  const f = faceFeatures.find((x) => x.id === id);
  if (!f) return;
  enterFaceEditMode({ featureId: f.id, basis: f.basis, boundaryLoopUV: f.boundaryLoopUV, innerLoopsUV: f.innerLoopsUV, modelReferenceUV: f.modelReferenceUV });
}

function deleteFaceFeature(id) {
  if (faceEditContext || faceSelectMode || newPlaneMode) return;
  faceFeatures = faceFeatures.filter((f) => f.id !== id);
  // The 2D view was showing this feature's now-deleted sketch - fall back to
  // the base sketch rather than leaving `shapes` pointed at an orphaned array.
  if (activeFeatureId === id) {
    if (baseShapesStash) {
      shapes = baseShapesStash.shapes;
      backgroundImages = baseShapesStash.backgroundImages;
    }
    history = [];
    activeFeatureId = null;
    renderShapeList();
  }
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

// Index into timelineEntries() of the entry currently open in the 2D view -
// either being actively (re-)edited, or just left there as the active
// display target after a previous "Übernehmen" (see activeFeatureId) - or
// null when the base sketch is what's open and nothing is mid-edit.
function currentTimelineIndex() {
  if (baseRollback) return 0;
  if (faceEditContext) {
    if (faceEditContext.featureId) {
      const i = faceFeatures.findIndex((f) => f.id === faceEditContext.featureId);
      return i >= 0 ? i + 1 : null;
    }
    return faceFeatures.length + 1; // brand-new feature, sketched beyond the current end - nothing to suppress
  }
  if (activeFeatureId != null) {
    const i = faceFeatures.findIndex((f) => f.id === activeFeatureId);
    return i >= 0 ? i + 1 : null;
  }
  return null;
}

function goToTimelineEntry(idx) {
  if (faceEditContext || faceSelectMode || newPlaneMode) return;
  const entry = timelineEntries()[idx];
  if (!entry) return;
  if (entry.type === 'base') {
    // Switch the 2D view back to the base sketch if some feature was the
    // active display target instead (see activeFeatureId/deleteFaceFeature).
    if (activeFeatureId !== null) {
      if (baseShapesStash) {
        shapes = baseShapesStash.shapes;
        backgroundImages = baseShapesStash.backgroundImages;
      }
      history = [];
      activeFeatureId = null;
    }
    baseRollback = true;
    btnExport.disabled = true;
    btnExportStep.disabled = true;
    extrudeStatusEl.textContent = 'Zurückgerollt zur Basis-Skizze (Vorschau zeigt nur die Basis, ohne Flächen-Features). „Übernehmen“ klicken, um bis zum Ende des Verlaufs zu aktualisieren.';
    selectedShapeIds.clear();
    renderShapeList();
    updateFaceEditUI();
    render();
    // Immediately show the base-only preview (see runLivePreview's baseRollback
    // branch) rather than waiting for the debounce or the first edit.
    cancelLivePreview();
    runLivePreview();
  } else {
    baseRollback = false;
    reopenFaceFeature(entry.feature.id);
  }
}

// Cancels a base rollback that hasn't been re-extruded yet, restoring the
// full end-of-history model without requiring any sketch changes.
function jumpToEndOfHistory() {
  if (faceEditContext || faceSelectMode || newPlaneMode || !baseRollback) return;
  rebuildSolid();
}

function renderHistoryTree() {
  const el = document.getElementById('history-tree');
  if (!el) return;
  el.innerHTML = '';
  const entries = timelineEntries();
  const curIdx = currentTimelineIndex();
  const busy = !!faceEditContext || faceSelectMode || newPlaneMode;

  // Later entries only get visually "suppressed" while truly mid-edit
  // (faceEditContext/baseRollback) - reopening an earlier feature rolls later
  // ones out of the live preview (see runLivePreview), so marking them as
  // such is accurate there. Merely having a feature as the active display
  // target after "Übernehmen" (activeFeatureId, no live edit in progress)
  // doesn't suppress anything - the 3D model already includes every feature.
  const midEdit = !!faceEditContext || baseRollback;

  entries.forEach((entry, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (curIdx !== null) {
      if (idx === curIdx) item.classList.add('editing');
      else if (idx > curIdx && midEdit) item.classList.add('suppressed');
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
    hint.textContent = 'Erst „Übernehmen“ oder „Abbrechen“, um eine andere Skizze zu wählen.';
    el.appendChild(hint);
  }
}

function updateFaceEditUI() {
  const selectHint = document.getElementById('face-select-hint');
  const editControls = document.getElementById('face-edit-controls');
  const title = document.getElementById('sketch-pane-title');

  if (selectHint) selectHint.style.display = faceSelectMode ? 'flex' : 'none';
  if (editControls) editControls.style.display = faceEditContext ? 'flex' : 'none';
  if (newPlanePanelBlock) newPlanePanelBlock.style.display = newPlaneMode ? 'block' : 'none';
  btnEditFace.disabled = !modelCommitted || faceSelectMode || !!faceEditContext || newPlaneMode;
  btnExportFaceDxf.disabled = !modelCommitted || faceSelectMode || !!faceEditContext || newPlaneMode;
  btnNewPlane.disabled = !modelCommitted || faceSelectMode || !!faceEditContext || newPlaneMode;

  if (title) {
    if (faceEditContext) {
      const idx = faceEditContext.featureId ? faceFeatures.findIndex((f) => f.id === faceEditContext.featureId) : faceFeatures.length;
      title.textContent = `Flächen-Skizze — Skizze ${idx + 2} — bearbeiten und „Übernehmen“ klicken`;
    } else if (baseRollback) {
      title.textContent = 'Basis-Skizze (zurückgerollt) — bearbeiten und „Übernehmen“ klicken';
    } else if (activeFeatureId != null) {
      const idx = faceFeatures.findIndex((f) => f.id === activeFeatureId);
      title.textContent = `Flächen-Skizze — Skizze ${idx + 2} (übernommen, weiter bearbeitbar)`;
    } else {
      title.textContent = '2D Skizze (Klicken zum Zeichnen)';
    }
  }
  renderHistoryTree();
}

const btnEditFace = document.getElementById('btn-edit-face');
const btnExportFaceDxf = document.getElementById('btn-export-face-dxf');
const btnCancelFaceSelect = document.getElementById('btn-cancel-face-select');
const btnCancelFaceEdit = document.getElementById('btn-cancel-face-edit');
const btnNewPlane = document.getElementById('btn-new-plane');
const newPlanePanelBlock = document.getElementById('new-plane-panel-block');
const planeAxisButtons = Array.from(document.querySelectorAll('#new-plane-panel-block [data-axis]'));
const planeOffsetInput = document.getElementById('plane-offset');
const planeAngleInput = document.getElementById('plane-angle');
const planeFlipInput = document.getElementById('plane-flip');
const btnCreatePlane = document.getElementById('btn-create-plane');
const btnCancelPlane = document.getElementById('btn-cancel-plane');

btnEditFace.addEventListener('click', () => {
  if (!modelCommitted || faceEditContext || faceSelectMode || newPlaneMode) return;
  faceSelectPurpose = 'edit';
  faceSelectMode = true;
  updateFaceEditUI();
});

btnExportFaceDxf.addEventListener('click', () => {
  if (!modelCommitted || faceEditContext || faceSelectMode || newPlaneMode) return;
  faceSelectPurpose = 'exportDxf';
  faceSelectMode = true;
  updateFaceEditUI();
});

btnCancelFaceSelect.addEventListener('click', () => {
  faceSelectMode = false;
  clearHoverHighlight();
  updateFaceEditUI();
});

btnCancelFaceEdit.addEventListener('click', () => exitFaceEditMode(false));

// ---- "Neue Ebene" (datum plane) panel wiring ---------------------------------

function openNewPlanePanel() {
  if (!modelCommitted || faceEditContext || faceSelectMode || newPlaneMode) return;
  newPlaneMode = true;
  newPlaneConfig = { axis: 'z', offset: 0, angle: 0, flip: false };
  planeAxisButtons.forEach((b) => b.classList.toggle('active', b.dataset.axis === 'z'));
  planeOffsetInput.value = '0';
  planeAngleInput.value = '0';
  planeFlipInput.checked = false;
  // Only configuring where the plane goes here - there's no feature sketch
  // yet to commit, so "Übernehmen" doesn't apply until "Ebene erstellen"
  // actually starts one (closeNewPlanePanel below re-enables it either way:
  // on create, entering the feature sketch; on cancel, back to normal).
  // Safe to disable unconditionally here (unlike doing this from
  // updateFaceEditUI, which also runs during the OC-kernel-loading window
  // and mid-drag) since reaching this point already required modelCommitted,
  // which itself required a completed rebuildSolid() - the kernel is loaded.
  btnExtrude.disabled = true;
  updateFaceEditUI();
  updateNewPlanePreview();
}

function closeNewPlanePanel() {
  newPlaneMode = false;
  clearNewPlanePreview();
  btnExtrude.disabled = false;
  updateFaceEditUI();
}

btnNewPlane.addEventListener('click', openNewPlanePanel);

planeAxisButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    newPlaneConfig.axis = btn.dataset.axis;
    planeAxisButtons.forEach((b) => b.classList.toggle('active', b === btn));
    updateNewPlanePreview();
  });
});

planeOffsetInput.addEventListener('input', () => {
  newPlaneConfig.offset = parseFloat(planeOffsetInput.value) || 0;
  updateNewPlanePreview();
});

planeAngleInput.addEventListener('input', () => {
  newPlaneConfig.angle = parseFloat(planeAngleInput.value) || 0;
  updateNewPlanePreview();
});

planeFlipInput.addEventListener('change', () => {
  newPlaneConfig.flip = planeFlipInput.checked;
  updateNewPlanePreview();
});

btnCancelPlane.addEventListener('click', closeNewPlanePanel);

// Commits the configured datum plane as a brand-new face feature (featureId:
// null) with no picked-face outline (boundaryLoopUV/innerLoopsUV empty) -
// enterFaceEditMode/exitFaceEditMode then handle it exactly like a feature
// sketched on a real picked face: real BREP boolean fuse/cut against the
// existing solid live (see runLivePreview) and finalized on "Übernehmen", and
// its own entry in the Verlauf timeline.
// The current model's edges (currentSolidForPicking - accurate here since
// "Neue Ebene" is only enabled at the true end of the timeline, never mid
// rollback/edit) are projected onto the new plane as a reference wireframe -
// see projectSolidEdgesToUV / drawFaceReferenceOutline.
btnCreatePlane.addEventListener('click', () => {
  const basis = computeCustomPlaneBasis(newPlaneConfig.axis, newPlaneConfig.offset, newPlaneConfig.angle, newPlaneConfig.flip);
  const modelReferenceUV = projectSolidEdgesToUV(currentSolidForPicking, basis);
  closeNewPlanePanel();
  enterFaceEditMode({ featureId: null, basis, boundaryLoopUV: [], innerLoopsUV: [], modelReferenceUV });
});

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
  // `shapes`/`backgroundImages` may currently be showing a feature's sketch
  // rather than the base's (see activeFeatureId) - the base's own data always
  // needs currentBaseSketch() to find it in that case.
  const base = currentBaseSketch();
  return {
    fileType: 'mrcad-project',
    version: PROJECT_FILE_VERSION,
    nextShapeId,
    nextFeatureId,
    nextEdgeFilletId,
    shapes: base.shapes,
    backgroundImages: base.backgroundImages.map(bg => ({ id: bg.id, dataUrl: bg.dataUrl, x1: bg.x1, y1: bg.y1, x2: bg.x2, y2: bg.y2 })),
    faceFeatures: faceFeatures.map(f => ({
      id: f.id,
      basis: {
        origin: vec3ToPlain(f.basis.origin),
        normal: vec3ToPlain(f.basis.normal),
        uAxis: vec3ToPlain(f.basis.uAxis),
        vAxis: vec3ToPlain(f.basis.vAxis),
        flipV: !!f.basis.flipV,
      },
      boundaryLoopUV: f.boundaryLoopUV,
      innerLoopsUV: f.innerLoopsUV,
      modelReferenceUV: f.modelReferenceUV || [],
      shapes: f.shapes,
      backgroundImages: (f.backgroundImages || []).map(bg => ({ id: bg.id, dataUrl: bg.dataUrl, x1: bg.x1, y1: bg.y1, x2: bg.x2, y2: bg.y2 })),
    })),
    edgeFillets: edgeFillets.map(f => ({ id: f.id, point: f.point, radius: f.radius })),
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
  if (faceEditContext || faceSelectMode || newPlaneMode) {
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

// Reconstructs background-image records from a project file's plain
// {id,dataUrl,x1,y1,x2,y2} entries, kicking off an async decode of each
// dataUrl into an HTMLImageElement - render() is called again once each
// image finishes loading, since drawBackgroundImages() can't draw it before then.
function hydrateBackgroundImages(list) {
  return (list || []).map(rec => {
    const bg = { id: rec.id, dataUrl: rec.dataUrl, x1: rec.x1, y1: rec.y1, x2: rec.x2, y2: rec.y2, el: null };
    const img = new Image();
    img.onload = () => { bg.el = img; render(); };
    img.src = rec.dataUrl;
    return bg;
  });
}

// Restores full editing state (base sketch, extrusion depth, face features)
// from a parsed project file, then rebuilds the 3D model.
function loadProject(data) {
  cancelInProgress();
  closeLengthEditor(false);
  closePointEditor(false);
  closeFilletEditor(false);
  closePivotEditor(false);
  closeEdgeFilletEditor(false);
  endDrag();
  endBgImageDrag();
  endRotateDrag();
  faceSelectMode = false;
  faceEditContext = null;
  baseRollback = false;
  activeFeatureId = null;
  baseShapesStash = null;
  newPlaneMode = false;
  clearNewPlanePreview();
  selectedShapeIds.clear();
  selectedBgImageId = null;
  panState = null;
  clearHoverHighlight();
  clearSelectedHighlight();
  clearHoverEdgeHighlight();
  clearSelectedEdgeHighlight();

  shapes = data.shapes;
  history = [];
  backgroundImages = hydrateBackgroundImages(data.backgroundImages);

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
      flipV: !!f.basis.flipV, // false for project files saved before this field existed - matches their original (unflipped) behavior
    },
    boundaryLoopUV: f.boundaryLoopUV,
    innerLoopsUV: f.innerLoopsUV || [],
    modelReferenceUV: f.modelReferenceUV || [],
    shapes: f.shapes,
    backgroundImages: hydrateBackgroundImages(f.backgroundImages),
  }));

  edgeFillets = (data.edgeFillets || []).map(f => ({ id: f.id, point: f.point, radius: f.radius }));

  const maxShapeId = shapes.reduce((m, s) => Math.max(m, s.id || 0), 0);
  const maxFeatureId = faceFeatures.reduce((m, f) => Math.max(m, f.id || 0), 0);
  const maxEdgeFilletId = edgeFillets.reduce((m, f) => Math.max(m, f.id || 0), 0);
  nextShapeId = data.nextShapeId || (maxShapeId + 1);
  nextFeatureId = data.nextFeatureId || (maxFeatureId + 1);
  nextEdgeFilletId = data.nextEdgeFilletId || (maxEdgeFilletId + 1);
  const allBgIds = backgroundImages.map(b => b.id).concat(faceFeatures.flatMap(f => f.backgroundImages.map(b => b.id)));
  nextBgImageId = allBgIds.length ? Math.max(...allBgIds) + 1 : 1;

  projectDirty = false;
  markDirty();
  renderShapeList();
  renderEdgeFilletList();
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

btnExportStep.addEventListener('click', () => {
  if (!currentSolidForPicking) return;
  const blob = currentSolidForPicking.blobSTEP();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modell.step';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ===========================================================================
// DXF export - a flat 2D outline as a laser/plotter template for a flat part
// like a gasket. Two entry points, both independent of the 3D extrusion/STL
// export above: the current 2D sketch (btn-export-dxf, works even before
// "Übernehmen"), and a picked flat face of the finished 3D model
// (btn-export-face-dxf - see startFaceDxfExport / the faceSelectPurpose branch
// in onViewerPointerUp).
// ===========================================================================

// Minimal ASCII DXF R12 (AC1009) writer. Takes a flat list of entities, each
// either {circle:{cx,cy,r}} or {polyline:[{x,y},...], closed:bool}, and lands
// them all on layer "0" - CAM/laser software infers inside/outside (part vs.
// hole) from the closed loops alone, so no isHole/isAdditive concept is needed.
function entitiesToDxf(entities) {
  const lines = [];
  const push = (code, value) => { lines.push(String(code), String(value)); };

  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'ENTITIES');
  entities.forEach(e => {
    if (e.circle) {
      push(0, 'CIRCLE'); push(8, '0');
      push(10, e.circle.cx); push(20, e.circle.cy); push(30, 0);
      push(40, e.circle.r);
    } else if (e.polyline && e.polyline.length >= 2) {
      push(0, 'POLYLINE'); push(8, '0');
      push(66, 1); push(70, e.closed ? 1 : 0);
      e.polyline.forEach(p => {
        push(0, 'VERTEX'); push(8, '0');
        push(10, p.x); push(20, p.y); push(30, 0);
      });
      push(0, 'SEQEND');
    }
  });
  push(0, 'ENDSEC');
  push(0, 'EOF');

  return lines.join('\n') + '\n';
}

function downloadDxf(text, filename) {
  const blob = new Blob([text], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// The current 2D sketch as DXF entities: polygon shapes via their already-
// tessellated outline (see getOutlinePoints, so fillets and bent/bulge edges
// come out as their approximated arc rather than a straight chord), circle
// shapes as true CIRCLE entities.
function sketchToDxfEntities() {
  const entities = [];
  shapes.forEach(shape => {
    if (shape.type === 'circle') {
      entities.push({ circle: { cx: shape.center.x, cy: shape.center.y, r: shape.radius } });
    } else if (shape.type === 'polygon') {
      const pts = getOutlinePoints(shape);
      if (pts.length >= 2) entities.push({ polyline: pts, closed: !shape.open });
    }
  });
  return entities;
}

btnExportDxf.addEventListener('click', () => {
  if (shapes.length === 0) return;
  downloadDxf(entitiesToDxf(sketchToDxfEntities()), 'skizze.dxf');
});

// A picked flat face's outer boundary + inner loops (holes), in the face's own
// flattened UV frame (mm), exported as closed polylines - the flat blank you'd
// cut to match that face. The loops come straight from the same face-region
// trace used to sketch on a face (see getFaceRegionForHit / buildFaceRegionResult).
function exportFaceAsDxf(result) {
  const entities = [];
  if (result.boundaryLoopUV && result.boundaryLoopUV.length >= 2) {
    entities.push({ polyline: result.boundaryLoopUV, closed: true });
  }
  (result.innerLoopsUV || []).forEach(loop => {
    if (loop.length >= 2) entities.push({ polyline: loop, closed: true });
  });
  if (entities.length === 0) return;
  downloadDxf(entitiesToDxf(entities), 'flaeche.dxf');
}

// ===========================================================================
// Init
// ===========================================================================

resizeCanvas();
viewScale = defaultViewScale();
centerView();
render();
renderShapeList();
renderHistoryTree();
initViewer();
initTextTool();
