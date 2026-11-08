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
  const candidates = [
    join(logDir, `${service}.out.log`),
    join(logDir, `${service}.err.log`),
    join(logDir, 'install.log'),
  ];
  for (let i = 1; i <= 8; i++) {
    candidates.push(join(logDir, `${service}.out.${i}.log`));
    candidates.push(join(logDir, `${service}.err.${i}.log`));
  }
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const m = /密码\s*[:：]\s*([0-9a-fA-F]{32})/.exec(text);
    if (m) return m[1].toLowerCase();
  }
  return '';
}

/** 日志尾部若干行，转成 ASCII 安全字符塞进 TIMEOUT 行，供安装器直接弹窗。 */
function tailHint() {
  const f = join(logDir, `${service}.err.log`);
  const g = join(logDir, `${service}.out.log`);
  const pick = existsSync(f) ? f : existsSync(g) ? g : '';
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
writeFileSync(join(logDir, 'credentials.txt'), body, 'utf8');

say(`OK ${user}|${password}`);
