/* 설치 아이콘(PNG)을 코드로 그립니다. 외부 라이브러리 없이 zlib 만 씁니다.
   4배로 그린 뒤 평균 내어 줄이므로 사선도 매끈합니다. */
const zlib = require("zlib");

const KRAFT = [0xc3, 0xa9, 0x7f];
const KRAFT_DK = [0xa2, 0x86, 0x5a];
const PAPER = [0xf1, 0xe9, 0xd9];
const INK = [0x22, 0x1d, 0x17];
const RED = [0x9c, 0x2b, 0x22];

/* ---------- PNG 인코딩 ---------- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.slice(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePNG(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8bit
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- 그리기 ---------- */
/* 크라프트 종이 위의 우편 봉투 한 장. inset 은 마스커블용 안전 영역(0~1). */
function makeIcon(size, inset = 1) {
  const S = 4;
  const W = size * S;
  const buf = Buffer.alloc(W * W * 3);
  // 배경은 가장자리까지 꽉 채웁니다 (원형·둥근 사각 어디로 잘려도 안전)
  for (let i = 0; i < W * W; i++) {
    buf[i * 3] = KRAFT[0];
    buf[i * 3 + 1] = KRAFT[1];
    buf[i * 3 + 2] = KRAFT[2];
  }

  const u = (v) => (0.5 + (v - 0.5) * inset) * W; // 단위좌표 → 픽셀
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 3;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(u(y0)); y < Math.round(u(y1)); y++)
      for (let x = Math.round(u(x0)); x < Math.round(u(x1)); x++) put(x, y, c);
  };
  const line = (x0, y0, x1, y1, tw, c) => {
    const ax = u(x0), ay = u(y0), bx = u(x1), by = u(y1), t = (tw * inset * W) / 2;
    const minX = Math.floor(Math.min(ax, bx) - t), maxX = Math.ceil(Math.max(ax, bx) + t);
    const minY = Math.floor(Math.min(ay, by) - t), maxY = Math.ceil(Math.max(ay, by) + t);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const s = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const px = ax + s * dx - x, py = ay + s * dy - y;
        if (px * px + py * py <= t * t) put(x, y, c);
      }
    }
  };

  // 봉투 — 테두리(진한 크라프트) 위에 종이색 몸통
  rect(0.14, 0.27, 0.86, 0.73, KRAFT_DK);
  rect(0.155, 0.285, 0.845, 0.715, PAPER);
  // 접힌 덮개
  line(0.155, 0.285, 0.5, 0.53, 0.035, KRAFT_DK);
  line(0.845, 0.285, 0.5, 0.53, 0.035, KRAFT_DK);
  // 우표 자리 — 앱의 빨간 소인
  rect(0.7, 0.6, 0.815, 0.685, RED);
  // 금액 줄 두 개
  line(0.185, 0.615, 0.55, 0.615, 0.028, INK);
  line(0.185, 0.675, 0.44, 0.675, 0.028, INK);

  // 4배 → 원래 크기로 평균 축소
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 3;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
        }
      }
      const n = S * S, o = (y * size + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return encodePNG(size, size, out);
}

module.exports = { makeIcon };
