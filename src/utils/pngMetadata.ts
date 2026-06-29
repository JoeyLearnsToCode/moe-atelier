const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function isPng(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const view = new Uint8Array(buffer, 0, 8);
  for (let i = 0; i < 8; i++) {
    if (view[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

export function injectPngITxt(
  buffer: ArrayBuffer,
  keyword: string,
  text: string,
): ArrayBuffer {
  if (!isPng(buffer)) return buffer;

  const enc = new TextEncoder();
  const keywordNul = enc.encode(keyword + '\0');
  const textBytes = enc.encode(text);

  const langTag = new Uint8Array([0]);
  const transKeyword = new Uint8Array([0]);

  const chunkData = new Uint8Array(
    keywordNul.length + 1 + 1 + langTag.length + transKeyword.length + textBytes.length,
  );
  let off = 0;
  chunkData.set(keywordNul, off); off += keywordNul.length;
  chunkData[off++] = 0; // compression flag: uncompressed
  chunkData[off++] = 0; // compression method: deflate
  chunkData.set(langTag, off); off += langTag.length;
  chunkData.set(transKeyword, off); off += transKeyword.length;
  chunkData.set(textBytes, off);

  const typeBytes = enc.encode('iTXt');
  const crcInput = new Uint8Array(typeBytes.length + chunkData.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(chunkData, typeBytes.length);
  const crcVal = crc32(crcInput);

  const chunkLen = chunkData.length;
  const chunk = new ArrayBuffer(12 + chunkLen);
  const cv = new DataView(chunk);
  cv.setUint32(0, chunkLen, false);
  cv.setUint32(4, 0x69545874, false);
  new Uint8Array(chunk, 8, chunkLen).set(chunkData);
  cv.setUint32(8 + chunkLen, crcVal, false);

  const src = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let pos = 8;

  while (pos + 12 <= src.length) {
    const len = dv.getUint32(pos, false);
    const typeStr = new TextDecoder().decode(src.subarray(pos + 4, pos + 8));
    if (typeStr === 'IDAT' || typeStr === 'IEND') break;
    pos += 12 + len;
  }

  if (pos + 12 > src.length) return buffer;

  const out = new Uint8Array(src.length + chunk.byteLength);
  out.set(src.subarray(0, pos), 0);
  out.set(new Uint8Array(chunk), pos);
  out.set(src.subarray(pos), pos + chunk.byteLength);

  return out.buffer as ArrayBuffer;
}
