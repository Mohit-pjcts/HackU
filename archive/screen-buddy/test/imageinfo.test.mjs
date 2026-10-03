import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBase64Image, ImageError, imageInfo } from "../lib/imageinfo.js";
import { jpegBuffer, pngBase64 } from "./helpers.mjs";

test("reads PNG size from the header", () => {
  const info = imageInfo(decodeBase64Image(pngBase64(1920, 1080)));
  assert.equal(info.mediaType, "image/png");
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
});

test("reads JPEG size from baseline and progressive frame headers", () => {
  for (const sof of [0xc0, 0xc2]) {
    const info = imageInfo(jpegBuffer(1366, 768, sof));
    assert.deepEqual([info.mediaType, info.width, info.height], ["image/jpeg", 1366, 768]);
  }
});

test("rejects data URLs, bad base64 and other formats", () => {
  assert.throws(() => decodeBase64Image("data:image/png;base64,AAAA"), ImageError);
  assert.throws(() => decodeBase64Image("not base64!!"), ImageError);
  assert.throws(() => imageInfo(Buffer.from("GIF89a" + "x".repeat(40))), (e) => e.code === "BAD_IMAGE_TYPE");
  assert.throws(() => imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, ...new Array(30).fill(0)])), ImageError);
});
