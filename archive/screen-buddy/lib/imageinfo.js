// Read the real type and pixel size of an uploaded image from its header bytes.
// We do not trust the imageWidth / imageHeight the page claims: if they are wrong,
// every coordinate we send back is wrong, so we check them.

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function decodeBase64Image(b64) {
  if (typeof b64 !== "string" || b64.length === 0) throw new ImageError("BAD_IMAGE", "imageBase64 is empty");
  if (b64.startsWith("data:")) throw new ImageError("BAD_IMAGE", "imageBase64 must not include a data: prefix");
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) throw new ImageError("BAD_IMAGE", "imageBase64 is not valid base64");
  return Buffer.from(b64, "base64");
}

/** Returns { mediaType, width, height, bytes } or throws ImageError. Supports JPEG and PNG. */
export function imageInfo(buf) {
  if (buf.length < 24) throw new ImageError("BAD_IMAGE", "image is too small to be valid");

  // PNG: 8-byte signature, then the IHDR chunk holds width and height (big-endian).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.toString("ascii", 12, 16) !== "IHDR") throw new ImageError("BAD_IMAGE", "PNG without IHDR");
    return { mediaType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  }

  // JPEG: walk the marker segments until a start-of-frame (SOFn) marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) throw new ImageError("BAD_IMAGE", "corrupt JPEG marker");
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { mediaType: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), bytes: buf.length };
      }
      if (len < 2) throw new ImageError("BAD_IMAGE", "corrupt JPEG segment");
      i += 2 + len;
    }
    throw new ImageError("BAD_IMAGE", "JPEG without a frame header");
  }

  throw new ImageError("BAD_IMAGE_TYPE", "only JPEG and PNG images are accepted");
}
