import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boxCenter, cellToPoint, cropBoxToFrame, cropRegionAround, cropToFrame, frameToClient, parseCell, pointInBox, sanitizeBox,
} from "../src/shared/geometry.js";

test("grid labels parse leniently but reject out-of-range cells", () => {
  assert.deepEqual(parseCell("C5", 12, 8), { col: 2, row: 4 });
  assert.deepEqual(parseCell(" c 05 ", 12, 8), { col: 2, row: 4 });
  assert.equal(parseCell("M1", 12, 8), null); // only A-L exist
  assert.equal(parseCell("A9", 12, 8), null);
  assert.equal(parseCell("A0", 12, 8), null);
  assert.equal(parseCell("AA1", 12, 8), null);
  assert.equal(parseCell(null, 12, 8), null);
});

test("cell + position maps to the right pixel", () => {
  // 1200x800 image, 12x8 grid -> 100x100 cells. C5 spans x 200-300, y 400-500.
  assert.deepEqual(cellToPoint("C5", "center", 12, 8, 1200, 800).point, { x: 250, y: 450 });
  assert.deepEqual(cellToPoint("C5", "top-left", 12, 8, 1200, 800).point, { x: 217, y: 417 });
  assert.deepEqual(cellToPoint("C5", "bottom-right", 12, 8, 1200, 800).box, [267, 467, 300, 500]);
  assert.deepEqual(cellToPoint("C5", "center", 12, 8, 1200, 800).box, [233, 433, 267, 467]);
  assert.deepEqual(cellToPoint("C5", "center", 12, 8, 1200, 800).cell, [200, 400, 300, 500]);
  assert.equal(cellToPoint("Z9", "center", 12, 8, 1200, 800), null);
});

test("sanitizeBox fixes swapped corners, clamps, and rejects nonsense", () => {
  assert.deepEqual(sanitizeBox([50, 60, 10, 20], 100, 100), [10, 20, 50, 60]);
  assert.deepEqual(sanitizeBox([-5, 10, 20, 30], 100, 100), [0, 10, 20, 30]);
  assert.equal(sanitizeBox([500, 500, 600, 600], 100, 100), null); // centre outside the image
  assert.equal(sanitizeBox([0, 0, 100, 100], 100, 100), null); // the whole screen is not a target
  assert.equal(sanitizeBox([1, 2, 3], 100, 100), null);
  assert.equal(sanitizeBox([1, 2, NaN, 4], 100, 100), null);
  assert.deepEqual(sanitizeBox([40, 40, 40, 40], 100, 100), [40, 40, 40, 40]); // a point is fine
});

test("refine crop stays inside the frame and maps back exactly", () => {
  const r = cropRegionAround({ x: 10, y: 10 }, 1920, 1080, 480, 300);
  assert.deepEqual(r, { x: 0, y: 0, width: 480, height: 300 });
  const r2 = cropRegionAround({ x: 1910, y: 1075 }, 1920, 1080, 480, 300);
  assert.deepEqual(r2, { x: 1440, y: 780, width: 480, height: 300 });
  // A point at crop pixel (300, 150) with 3x zoom and offset (1440, 780) is frame (1540, 830).
  assert.deepEqual(cropToFrame({ x: 300, y: 150 }, 1440, 780, 3), { x: 1540, y: 830 });
  assert.deepEqual(cropBoxToFrame([0, 0, 30, 60], 100, 200, 3), [100, 200, 110, 220]);
});

test("frame pixels map to CSS pixels on a 2x display", () => {
  // A 2880x1800 capture of a 1440x900 CSS viewport.
  assert.deepEqual(frameToClient({ x: 1440, y: 900 }, 2880, 1800, { left: 0, top: 0, width: 1440, height: 900 }), { x: 720, y: 450 });
});

test("box helpers", () => {
  assert.deepEqual(boxCenter([10, 20, 30, 40]), { x: 20, y: 30 });
  assert.ok(pointInBox({ x: 10, y: 10 }, [10, 10, 20, 20]));
  assert.ok(!pointInBox({ x: 9, y: 10 }, [10, 10, 20, 20]));
  assert.ok(pointInBox({ x: 9, y: 10 }, [10, 10, 20, 20], 2));
});
