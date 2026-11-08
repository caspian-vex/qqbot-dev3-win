// 等服务起来，把首次生成的面板密码捞出来交给安装向导。
//
// 为什么需要它：初始密码只在 password_hash 为空时打印一次到 stdout
// （src/main.ts 的 ensureAdminPassword），而 Windows 服务没有控制台，
// 那些输出只落在 WinSW 重定向出来的日志文件里。不主动捞，
// 用户装完根本不知道密码，唯一出路是 reset-password。
//
// 输出约定（installer.nsi 用 nsExec::ExecToStack 读，只能吃纯 ASCII）：
//   首次安装  -> OK admin|<32位hex>
//   覆盖升级  -> EXISTING
//   失败      -> TIMEOUT <一行原因>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const root = resolve(arg('root', join(process.env.ProgramData ?? 'C:\\ProgramData', 'qqbot')));
const service = arg('service', 'qqbot');
const url = arg('url', 'http://127.0.0.1:5666/healthz');
const timeoutSec = Number(arg('timeout', '90'));

const logDir = join(root, 'logs');

// WinSW 的日志文件名取自**可执行文件名**，而我们的 exe 是 qqbot-svc.exe，
// 于是落到 qqbot-svc.out.log。只按服务名 qqbot.out.log 找会永远找不到，
// 结果是"装完了但取不到初始密码"。两个都扫，兼容手工改过 exe 名的情况。
const stems = [...new Set([`${service}-svc`, service, arg('log-stem', '')].filter((s) => s !== ''))];

// provision.mjs 在装本体之前记下了各日志的长度。只看这之后新增的内容，
// 否则覆盖安装会把上一次（可能是改密码之前）的横幅当成这次的新密码。
let offsets = {};
try {
  offsets = JSON.parse(readFileSync(join(logDir, '.log-offsets.json'), 'utf8'));
} catch {
  offsets = {};
}

function logCandidates() {
  const list = [];
  for (const stem of stems) {
    list.push(join(logDir, `${stem}.out.log`), join(logDir, `${stem}.err.log`));
    for (let i = 1; i <= 8; i++) {
      list.push(join(logDir, `${stem}.out.${i}.log`), join(logDir, `${stem}.err.${i}.log`));
    }
  }
  return list;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ready() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 在日志里找密码横幅；WinSW 的按大小轮转会产生 .1 .2 之类的历史文件，一起扫。 */
function findPassword() {
  const candidates = logCandidates();
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // 只保留本次安装之后新写入的部分
    const from = offsets[f.split(/[\\/]/).pop()] ?? 0;
    if (from > 0) {
      if (text.length <= from) continue;
      text = text.slice(from);
    }
    const m = /密码\s*[:：]\s*([0-9a-fA-F]{32})/.exec(text);
    if (m) return m[1].toLowerCase();
  }
  return '';
}

/** 日志尾部若干行，转成 ASCII 安全字符塞进 TIMEOUT 行，供安装器直接弹窗。 */
function tailHint() {
  const pick = logCandidates().find((f) => f.includes('.err.log') && existsSync(f))
    ?? logCandidates().find((f) => existsSync(f))
    ?? '';
  if (pick === '') return 'no-log-file';
  try {
    const lines = readFileSync(pick, 'utf8').trim().split('\n').slice(-3).join(' | ');
    return lines.replace(/[^\x20-\x7e]/g, '?').slice(0, 220);
  } catch {
    return 'log-unreadable';
  }
}

const deadline = Date.now() + timeoutSec * 1000;
let up = false;
while (Date.now() < deadline) {
  if (await ready()) {
    up = true;
    break;
  }
  await sleep(1000);
}

if (!up) {
  say(`TIMEOUT 服务在 ${timeoutSec} 秒内没有响应 ${url} :: ${tailHint()}`);
  process.exit(0);
}

// 服务已经 200 了，但密码横幅可能比 /healthz 稍晚落盘（先启动 HTTP 再打印？
// 实际顺序相反，但日志写入有缓冲），再给几秒。
let password = '';
for (let i = 0; i < 8; i++) {
  password = findPassword();
  if (password !== '') break;
  await sleep(750);
}

if (password === '') {
  say('EXISTING');
  process.exit(0);
}

const user = 'admin';
const body =
  'qqbot 面板凭据\r\n' +
  '================\r\n' +
  `地址  : ${url.replace(/\/healthz$/, '')}\r\n` +
  `用户名: ${user}\r\n` +
  `密码  : ${password}\r\n` +
  `生成于: ${new Date().toLocaleString('zh-CN')}\r\n` +
  '\r\n这串密码只在这里和你保存的副本里各有一份，关掉面板也不会再显示。\r\n' +
  '忘了就运行开始菜单里的「重置面板密码」。\r\n';
// 写 BOM：这个文件是给人用记事本打开的，无 BOM 的 UTF-8 在旧版记事本里
// 会按 ANSI 解，中文全成乱码（安装日志那边同理）。
writeFileSync(join(logDir, 'credentials.txt'), `\uFEFF${body}`, 'utf8');

say(`OK ${user}|${password}`);
