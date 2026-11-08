// 生成安装包图标（assets/qqbot.ico）。
//
// 为什么自己画而不是找一张图：仓库里没有任何图片资源，而 NSIS 的安装程序、
// 开始菜单快捷方式、卸载项都需要一个 .ico。与其引入一条"去网上找素材 + 版权存疑"
// 的链路，不如用 30 行代码画一个确定可再生成的。
//
// 输出：packaging/win/assets/qqbot.ico（多尺寸，PNG 压缩帧）
//       build/icon-preview.png（256 预览，方便肉眼检查）
// 依赖：只用 node 内置 zlib —— 不需要 sharp/canvas，也不引入构建期原生模块。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT_DIR = resolve(import.meta.dirname, 'assets');
const PREVIEW = resolve(import.meta.dirname, '..', '..', 'build', 'icon-preview.png');

// ---- PNG 编码 ----

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行前面加一个 filter 字节（0 = None）。逐行自适应过滤能再小一点，
  // 但图标就几十 KB，不值得为此引入一套过滤选择逻辑。
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 画图 ----

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形的有符号距离：<0 在内部。 */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 点到线段距离，用来画 Q 的那一撇。 */
function sdSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = clamp01(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy));
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * 按尺寸画一张。
 * 用 3 倍超采样再降采样：圆环和尾巴的斜边在不做抗锯齿时会是一圈锯齿，
 * 图标虽小但那是第一眼印象。
 */
function render(size) {
  const SS = 3;
  const n = size * SS;
  const acc = new Float32Array(size * size * 4);

  const cx = n / 2;
  const cy = n / 2;
  const half = n * 0.44; // 圆角方块留 6% 边距
  const radius = n * 0.23;

  const ringR = n * 0.25;
  const ringW = n * 0.085;
  // 尾巴必须收在圆角方块内部：伸到角落会被 d>0 的裁剪切掉，
  // 渲染出来是"右下角被啃了一口"，比没有尾巴更难看。
  const tailFrom = [cx + ringR * 0.52, cy + ringR * 0.52];
  const tailTo = [cx + ringR * 1.18, cy + ringR * 1.18];
  const tailW = ringW * 0.82;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // 背景：左上靛蓝 → 右下青，斜向渐变
      const t = clamp01((px / n) * 0.65 + (py / n) * 0.35);
      const r0 = Math.round(91 + (34 - 91) * t);
      const g0 = Math.round(108 + (211 - 108) * t);
      const b0 = Math.round(255 + (238 - 255) * t);

      // 圆角方块外是透明的
      const d = sdRoundRect(px, py, cx, cy, half, half, radius);
      if (d > 0) continue;

      // 圆环（字母 O）
      const dist = Math.hypot(px - cx, py - cy);
      const inRing = Math.abs(dist - ringR) <= ringW / 2;
      // 尾巴（让 O 变成 Q）
      const inTail = sdSegment(px, py, tailFrom[0], tailFrom[1], tailTo[0], tailTo[1]) <= tailW / 2;

      const ix = Math.floor(x / SS);
      const iy = Math.floor(y / SS);
      const o = (iy * size + ix) * 4;

      if (inRing || inTail) {
        acc[o] += 255;
        acc[o + 1] += 255;
        acc[o + 2] += 255;
        acc[o + 3] += 255;
      } else {
        acc[o] += r0;
        acc[o + 1] += g0;
        acc[o + 2] += b0;
        acc[o + 3] += 255;
      }
    }
  }

  const rgba = Buffer.alloc(size * size * 4);
  const per = SS * SS;
  for (let i = 0; i < size * size * 4; i++) rgba[i] = Math.round(acc[i] / per);
  return rgba;
}

// ---- ICO 封装 ----

function buildIco(sizes) {
  const frames = sizes.map((s) => ({ size: s, png: encodePNG(s, render(s)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e[0] = f.size >= 256 ? 0 : f.size; // 0 表示 256
    e[1] = f.size >= 256 ? 0 : f.size;
    e[2] = 0; // 调色板数
    e[3] = 0;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(f.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += f.png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

mkdirSync(OUT_DIR, { recursive: true });
const ico = buildIco([16, 24, 32, 48, 64, 128, 256]);
writeFileSync(join(OUT_DIR, 'qqbot.ico'), ico);
console.log(`qqbot.ico ${(ico.length / 1024).toFixed(1)} KB`);

mkdirSync(resolve(PREVIEW, '..'), { recursive: true });
writeFileSync(PREVIEW, encodePNG(256, render(256)));
console.log(`预览: ${PREVIEW}`);
