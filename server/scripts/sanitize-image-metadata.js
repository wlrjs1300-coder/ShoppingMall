const fs = require("node:fs");
const path = require("node:path");

// JPEG 픽셀 스트림은 그대로 두고 APP1(EXIF/XMP), APP13(IPTC), COM만 제거한다.
function stripJpegMetadata(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error("JPEG 파일이 아닙니다.");
  const chunks = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset < buffer.length) {
    const markerStart = offset;
    if (buffer[offset] !== 0xff) { chunks.push(buffer.subarray(offset)); break; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xda || marker === 0xd9) { chunks.push(buffer.subarray(markerStart)); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(buffer.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > buffer.length) throw new Error("손상된 JPEG 세그먼트입니다.");
    const length = buffer.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > buffer.length) throw new Error("손상된 JPEG 길이입니다.");
    const shouldRemove = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!shouldRemove) chunks.push(buffer.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  return Buffer.concat(chunks);
}

const files = process.argv.slice(2);
if (!files.length) throw new Error("사용법: node sanitize-image-metadata.js <image.jpg> [...]");
for (const input of files) {
  const file = path.resolve(input);
  const original = fs.readFileSync(file);
  const sanitized = stripJpegMetadata(original);
  fs.writeFileSync(file, sanitized);
  console.log(`${input}: ${original.length - sanitized.length} bytes metadata removed`);
}
