// Coordinate helpers shared by the browser and the server.
// Every function here is pure, so it is unit-tested in test/geometry.test.mjs.

// ---------------------------------------------------------------------------
// Grid mode: the page draws a labelled grid on the image; the model answers
// with a cell label ("C5") and one of nine positions inside that cell.
// Columns are letters (A, B, C, ...), rows are numbers (1, 2, 3, ...).
// ---------------------------------------------------------------------------

export const GRID_DEFAULT = Object.freeze({ cols: 12, rows: 8 });
export const GRID_LIMITS = Object.freeze({ minCols: 2, maxCols: 26, minRows: 2, maxRows: 20 });

export const CELL_POSITIONS = Object.freeze([
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
]);

const POSITION_OFFSETS = {
  "top-left": [1 / 6, 1 / 6], top: [1 / 2, 1 / 6], "top-right": [5 / 6, 1 / 6],
  left: [1 / 6, 1 / 2], center: [1 / 2, 1 / 2], right: [5 / 6, 1 / 2],
  "bottom-left": [1 / 6, 5 / 6], bottom: [1 / 2, 5 / 6], "bottom-right": [5 / 6, 5 / 6],
};

export function columnLetter(index) {
  return String.fromCharCode(65 + index);
}

export function cellLabel(col, row) {
  return `${columnLetter(col)}${row + 1}`;
}

/** Parse "c5", " C 5 ", "C05" -> { col: 2, row: 4 }. Returns null if invalid. */
export function parseCell(label, cols, rows) {
  const m = /^\s*([A-Za-z])\s*0*(\d{1,2})\s*$/.exec(String(label ?? ""));
  if (!m) return null;
  const col = m[1].toUpperCase().charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, row };
}

/** Cell rectangle in image pixels. Cells split the image evenly (last cells absorb rounding). */
export function cellRect(col, row, cols, rows, width, height) {
  const x1 = (col * width) / cols;
  const y1 = (row * height) / rows;
  return { x1, y1, x2: ((col + 1) * width) / cols, y2: ((row + 1) * height) / rows };
}

/** Cell label + position -> pixel point in the image. Returns null if the label is invalid. */
export function cellToPoint(label, position, cols, rows, width, height) {
  const cell = parseCell(label, cols, rows);
  if (!cell) return null;
  const r = cellRect(cell.col, cell.row, cols, rows, width, height);
  const [fx, fy] = POSITION_OFFSETS[position] ?? POSITION_OFFSETS.center;
  const cw = r.x2 - r.x1;
  const ch = r.y2 - r.y1;
  return {
    point: { x: Math.round(r.x1 + fx * cw), y: Math.round(r.y1 + fy * ch) },
    // The answer's real precision: the third of the cell the position names.
    box: [
      Math.round(r.x1 + (fx - 1 / 6) * cw), Math.round(r.y1 + (fy - 1 / 6) * ch),
      Math.round(r.x1 + (fx + 1 / 6) * cw), Math.round(r.y1 + (fy + 1 / 6) * ch),
    ],
    cell: [Math.round(r.x1), Math.round(r.y1), Math.round(r.x2), Math.round(r.y2)],
  };
}

// ---------------------------------------------------------------------------
// Boxes and points
// ---------------------------------------------------------------------------

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Normalise a model box [x1, y1, x2, y2] against an image size.
 * Swapped corners are fixed. Returns null when the box is unusable:
 * not four finite numbers, mostly outside the image, or zero-area.
 */
export function sanitizeBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  let [x1, y1, x2, y2] = box;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  // Reject boxes whose centre is outside the image: the model is pointing at nothing we sent.
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  if (cx < 0 || cy < 0 || cx > width || cy > height) return null;
  x1 = clamp(x1, 0, width); x2 = clamp(x2, 0, width);
  y1 = clamp(y1, 0, height); y2 = clamp(y2, 0, height);
  if (x2 - x1 < 1 && y2 - y1 < 1) {
    // A point given as a box. Accept it; the overlay draws a minimum-size ring.
    return [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
  }
  // A "target" bigger than 60% of the image in both directions is not a click target.
  if (x2 - x1 > width * 0.6 && y2 - y1 > height * 0.6) return null;
  return [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
}

export function boxCenter(box) {
  return { x: Math.round((box[0] + box[2]) / 2), y: Math.round((box[1] + box[3]) / 2) };
}

export function pointInBox(point, box, tolerancePx = 0) {
  return (
    point.x >= box[0] - tolerancePx && point.x <= box[2] + tolerancePx &&
    point.y >= box[1] - tolerancePx && point.y <= box[3] + tolerancePx
  );
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Refine mode: crop a region around a first guess, zoom it, ask again.
// Contract: crop pixel (x, y) maps to frame pixel
//   (cropOffsetX + x / cropScale, cropOffsetY + y / cropScale)
// ---------------------------------------------------------------------------

/**
 * Region of the full-resolution frame to crop around a coarse point.
 * The region keeps the requested size where possible and is shifted (not shrunk)
 * to stay inside the frame.
 */
export function cropRegionAround(point, frameWidth, frameHeight, regionWidth, regionHeight) {
  const w = Math.min(regionWidth, frameWidth);
  const h = Math.min(regionHeight, frameHeight);
  const x = clamp(Math.round(point.x - w / 2), 0, frameWidth - w);
  const y = clamp(Math.round(point.y - h / 2), 0, frameHeight - h);
  return { x, y, width: w, height: h };
}

export function cropToFrame(point, cropOffsetX, cropOffsetY, cropScale) {
  return { x: cropOffsetX + point.x / cropScale, y: cropOffsetY + point.y / cropScale };
}

export function cropBoxToFrame(box, cropOffsetX, cropOffsetY, cropScale) {
  return [
    cropOffsetX + box[0] / cropScale, cropOffsetY + box[1] / cropScale,
    cropOffsetX + box[2] / cropScale, cropOffsetY + box[3] / cropScale,
  ];
}

/**
 * Map a point in captured-frame pixels to CSS pixels in the page.
 * `rect` is the on-screen rectangle (getBoundingClientRect) of the area the frame shows.
 * For a whole-tab capture that is { left: 0, top: 0, width: innerWidth, height: innerHeight }.
 * This handles devicePixelRatio and browser zoom automatically, because the frame size
 * and the CSS size are both measured rather than assumed.
 */
export function frameToClient(point, frameWidth, frameHeight, rect) {
  return {
    x: rect.left + (point.x / frameWidth) * rect.width,
    y: rect.top + (point.y / frameHeight) * rect.height,
  };
}

/** Scale a point from model-image pixels back to frame pixels. */
export function imageToFrame(point, imageScale) {
  return { x: point.x / imageScale, y: point.y / imageScale };
}
