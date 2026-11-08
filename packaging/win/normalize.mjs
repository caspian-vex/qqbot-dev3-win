#!/usr/bin/env node
/**
 * 把 Windows 原生脚本的编码/行尾归一化。
 *
 * 这几条不是风格偏好，是硬性要求：
 *   - .ps1   必须是 UTF-8 **带 BOM**。PowerShell 5.1 在没有 BOM 时按 ANSI(GBK) 解码，
 *            文件里的中文会把后面的 `}` 吃掉，报“缺少右 }”——排查起来极其费时。
 *   - .nsi   makensis 靠 BOM 判断脚本是 UTF-8；没有 BOM 就按 ANSI 读，
 *            安装向导里所有中文变乱码。
 *   - .cmd/.bat 必须是 CRLF，且**不能**有 BOM（BOM 会被当成命令的一部分，
 *            报 “'' 不是内部或外部命令”）。
 *   - .txt   给记事本看的，带 BOM 才不会在老版本记事本里乱码。
 *
 * 幂等：已经是目标状态的文件不会被重写。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** @type {Record<string, {bom: boolean}>} */
const RULES = {
  '.ps1': { bom: true },
  '.psm1': { bom: true },
  '.nsi': { bom: true },
  '.nsh': { bom: true },
  '.txt': { bom: true },
  '.cmd': { bom: false },
  '.bat': { bom: false },
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (RULES[extname(p).toLowerCase()]) out.push(p);
  }
  return out;
}

/** @returns {'ok'|'fixed'} */
export function normalizeFile(path) {
  const rule = RULES[extname(path).toLowerCase()];
  if (!rule) return 'ok';

  const raw = readFileSync(path);
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let body = hasBom ? raw.subarray(3) : raw;

  // 统一成 LF 再统一成 CRLF，避免出现 CRCRLF
  const text = body.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const crlf = text.replace(/\n/g, '\r\n');

  const wantBom = rule.bom;
  const next = Buffer.concat([
    ...(wantBom ? [BOM] : []),
    Buffer.from(crlf, 'utf8'),
  ]);

  if (next.equals(raw)) return 'ok';
  writeFileSync(path, next);
  return 'fixed';
}

/** 批量归一化一个目录，返回被改动的文件列表。 */
export function normalizeTree(dir, { log = () => {} } = {}) {
  const fixed = [];
  for (const p of walk(dir)) {
    try {
      if (normalizeFile(p) === 'fixed') {
        fixed.push(p);
        log(`  归一化 ${p}`);
      }
    } catch (err) {
      log(`  ! 跳过 ${p}：${err.message}`);
    }
  }
  return fixed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
  console.log(`归一化 ${target}`);
  // 允许直接传文件：只归一化这一个，不要再往目录递归。
  if (statSync(target).isFile()) {
    const r = normalizeFile(target);
    console.log(r === 'fixed' ? `  改动 ${target}` : '  已符合要求');
  } else {
    const fixed = normalizeTree(target, { log: console.log });
    console.log(fixed.length === 0 ? '  全部已符合要求' : `  改动 ${fixed.length} 个文件`);
  }
}
