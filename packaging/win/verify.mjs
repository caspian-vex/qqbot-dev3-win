#!/usr/bin/env node
/**
 * 装机结果自检。
 *
 * 安装包跑完之后用它验收：服务是不是真的在跑、跑在哪个账号下、面板有没有起来、
 * 权限有没有配歪、协议端的计划任务在不在。
 *
 * 只读：不改任何东西，不需要管理员权限（个别项在受限账号下会显示 SKIP）。
 *
 * 实现上的选择：服务状态 / 端口 / 计划任务 / 卸载登记信息全部由一个 PowerShell
 * 探测脚本以 JSON 吐回来，而不是解析 `sc query`、`netstat`、`schtasks` 的文本。
 * 那些命令的输出是**本地化**的，写中文的 Windows 上"STATE"会变成"状态"，
 * 按英文关键字匹配的检查会在别人的机器上静默失效。JSON 不含人类文案，稳得多。
 *
 * 用法：
 *   node packaging/win/verify.mjs
 *   node packaging/win/verify.mjs --root D:\qqbot-data --url http://127.0.0.1:5666
 *   node packaging/win/verify.mjs --quiet   # 只输出结果行，适合贴给别人看
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
function arg(name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const quiet = argv.includes('--quiet');
const root = resolve(arg('root', join(process.env.ProgramData ?? 'C:\\ProgramData', 'qqbot')));
const installDir = resolve(arg('install', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'qqbot')));
const baseUrl = arg('url', 'http://127.0.0.1:5666');
const service = arg('service', 'qqbot');

const results = [];
let width = 0;

function record(state, name, detail = '') {
  results.push({ state, name, detail });
  width = Math.max(width, name.length);
}

const pass = (n, d) => record('PASS', n, d);
const fail = (n, d) => record('FAIL', n, d);
const skip = (n, d) => record('SKIP', n, d);
const warn = (n, d) => record('WARN', n, d);

function head(title) {
  if (quiet) return;
  process.stdout.write(`\n── ${title}\n`);
}

function note(text) {
  if (!quiet) process.stdout.write(`   ${text}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑 PowerShell，返回解析后的 JSON；失败返回 null。
 *
 * 为什么落盘成 .ps1 再 -File，而不是 -EncodedCommand：同一个脚本走 -EncodedCommand
 * 在本机 PowerShell 5.1 上会莫名返回非 0 退出码（脚本本身语法没问题），
 * 而落盘执行稳定。顺带好处是出问题时脚本就留在那儿，可以直接手工重跑。
 * .ps1 含中文，必须带 UTF-8 BOM，否则 5.1 按 ANSI 解码会出乱码。
 */
function psJson(script, timeout = 25000) {
  const file = join(tmpdir(), 'qqbot-verify-probe.ps1');
  const full = `$ProgressPreference = 'SilentlyContinue'\r\n${script.replace(/\r?\n/g, '\r\n')}`;
  try {
    writeFileSync(file, `\uFEFF${full}`, 'utf8');
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error(`没有 JSON 输出: ${out.slice(0, 200)}`);
    return JSON.parse(out.slice(start, end + 1));
  } catch (e) {
    if (!quiet) process.stdout.write(`   [探测脚本: ${file}] ${String(e.message).split('\n')[0]}\n`);
    return null;
  }
}

/** 看一眼路径；区分「不存在」和「没权限看」。ACL 收紧后没权限是正常的。 */
function fsProbe(p) {
  try {
    statSync(p);
    return 'ok';
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return 'denied';
    return 'missing';
  }
}

/** 真的去连一下。比解析 netstat 可靠，也不受本地化影响。 */
function tryConnect(host, port, timeout = 800) {
  return new Promise((done) => {
    const sock = connect({ host, port });
    const finish = (ok) => {
      sock.destroy();
      done(ok);
    };
    sock.setTimeout(timeout, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

// ---- 一次性探测系统状态 ----

const svcEsc = service.replace(/'/g, "''");
const probeScript = `
$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
$svc = Get-CimInstance Win32_Service -Filter "Name='${svcEsc}'"
if ($svc) {
  $r.service = [ordered]@{
    exists  = $true
    state   = $svc.State
    start   = $svc.StartMode
    account = $svc.StartName
    display = $svc.DisplayName
  }
} else { $r.service = @{ exists = $false } }

$key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\qqbot'
if (Test-Path $key) {
  $p = Get-ItemProperty $key
  $r.uninstall = [ordered]@{ version = $p.DisplayVersion; location = $p.InstallLocation }
} else { $r.uninstall = @{ version = '' } }

# 端口不在这里查：Get-NetTCPConnection 只看得到本账号持有的连接，
# 服务以 qqbot_svc 身份监听的端口它一条都不返回，用它判断会稳定误报。
# 端口改由下面直接 TCP 连接来验证。
$task = $null
try { $task = Get-ScheduledTask -TaskName 'qqbot-napcat' -ErrorAction Stop } catch { $task = $null }
if (-not $task) {
  # 模块在 -NonInteractive 下偶尔拿不到任务，退回 CIM 直接查，不依赖模块加载
  try {
    $task = Get-CimInstance -Namespace 'root/Microsoft/Windows/TaskScheduler' -ClassName MSFT_ScheduledTask -Filter "TaskName='qqbot-napcat'" -ErrorAction Stop
  } catch { $task = $null }
}
if ($task) { $r.task = [ordered]@{ exists = $true; state = "$($task.State)" } } else { $r.task = @{ exists = $false } }

$r | ConvertTo-Json -Depth 5 -Compress
`;

head('系统状态');
const probe = psJson(probeScript);
if (!probe) note('系统探测失败（PowerShell 不可用），下面部分项目只能显示 SKIP');

// ---- 1. 文件 ----

head('安装文件');
const mustFiles = [
  'dist/server.js',
  'dist/argon-worker.js',
  'node/node.exe',
  'web/dist/index.html',
  'web/dist/app.js',
  'web/dist/style.css',
  'service/qqbot-svc.exe',
  'service/qqbot-svc.xml',
  'tools/provision.mjs',
  'tools/wait-credential.mjs',
  'tools/set-service-account.mjs',
  'tools/precheck.ps1',
  'tools/account.ps1',
  'qqbot.cmd',
  'start-napcat.cmd',
  'restart-service.cmd',
  'uninstall.exe',
  'VERSION',
];

const missing = mustFiles.filter((f) => !existsSync(join(installDir, f)));
if (missing.length === 0) pass('程序文件齐全', `${mustFiles.length} 项`);
else fail('程序文件齐全', `缺 ${missing.join(', ')}`);

if (existsSync(join(installDir, 'node_modules'))) warn('没有 node_modules', '存在，说明装的不是打包产物');
else pass('没有 node_modules', '运行期只有 node.exe + 两个 bundle');

if (existsSync(join(installDir, 'dist/server.js'))) {
  pass('server.js 已打包', `${(statSync(join(installDir, 'dist/server.js')).size / 1024).toFixed(0)} KB`);
}

if (existsSync(join(installDir, 'VERSION'))) {
  note(`版本：${readFileSync(join(installDir, 'VERSION'), 'utf8').trim().split(/\r?\n/).join(' / ')}`);
}

// ---- 2. 数据目录 ----

head('数据目录');
let denied = 0;
for (const d of ['etc', 'data\\qqbot', 'logs', 'backup']) {
  const st = fsProbe(join(root, d));
  if (st === 'ok') {
    pass(`${d}\\ 存在`);
  } else if (st === 'denied') {
    denied++;
    skip(`${d}\\ 不可读`, 'ACL 已收紧到服务账号，当前用户无权读取');
  } else {
    fail(`${d}\\ 存在`, join(root, d));
  }
}

/** 读一个必须存在、但可能没权限读的配置：没权限不算失败，记 SKIP。 */
function checkConfigFile(relPath, label, validate) {
  const p = join(root, relPath);
  const st = fsProbe(p);
  if (st === 'missing') {
    fail(label, '不存在');
    return;
  }
  if (st === 'denied') {
    denied++;
    skip(label, 'ACL 已收紧，当前用户无权读取');
    return;
  }
  let text = '';
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    skip(label, '读取失败');
    return;
  }
  validate(text);
}

checkConfigFile('etc\\secrets.env', 'secrets.env 三个密钥', (text) => {
  const lack = ['QQBOT_SECRET_KEY', 'QQBOT_ONEBOT_TOKEN', 'QQBOT_WEBUI_TOKEN'].filter(
    (k) => !new RegExp(`^${k}=[0-9a-f]{32,64}$`, 'm').test(text),
  );
  if (lack.length === 0) pass('secrets.env 三个密钥', '格式正确');
  else fail('secrets.env 三个密钥', `缺失或格式不对: ${lack.join(', ')}`);
});

checkConfigFile('etc\\qqbot.toml', 'qqbot.toml 可读', (toml) => {
  const zone = /^\s*zone\s*=\s*"([^"]*)"/m.exec(toml);
  const listen = /^\s*listen\s*=\s*"([^"]*)"/m.exec(toml);
  pass('qqbot.toml 可读', `time.zone=${zone ? zone[1] || '(跟随系统)' : '?'} panel.listen=${listen ? listen[1] : '?'}`);
  if (listen && (listen[1].startsWith('0.0.0.0') || listen[1].startsWith('[::]'))) {
    warn('面板只监听本机', `当前是 ${listen[1]}，局域网也能访问`);
  } else if (listen) {
    pass('面板只监听本机', listen[1]);
  }
});

// ---- 3. 服务 ----

head('Windows 服务');
const svc = probe?.service;
if (!svc || !svc.exists) {
  fail(`服务 ${service} 已注册`, 'Win32_Service 查不到');
} else {
  pass(`服务 ${service} 已注册`, svc.display || '');

  const who = svc.account || '?';
  if (/LocalSystem|NT AUTHORITY\\SYSTEM/i.test(who)) {
    fail('服务用低权限账号运行', `${who}：等于把整机管理员权限交给模型`);
  } else if (/qqbot/i.test(who)) {
    pass('服务用低权限账号运行', who);
  } else {
    warn('服务用低权限账号运行', who);
  }

  if (/AUTO/i.test(svc.start || '')) pass('服务开机自启', svc.start);
  else warn('服务开机自启', `${svc.start}（安装时取消勾选就是这个结果）`);

  if (/RUNNING/i.test(svc.state || '')) pass('服务正在运行', 'RUNNING');
  else fail('服务正在运行', svc.state || '未知');
}

// ---- 4. 服务账号 ----

head('服务账号');
const acctFile = join(root, 'etc', 'service-account.json');
let acctName = 'qqbot_svc';
if (existsSync(acctFile)) {
  try {
    acctName = JSON.parse(readFileSync(acctFile, 'utf8')).account || acctName;
  } catch {
    warn('service-account.json 解析', '格式不对');
  }
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    return e.stdout ?? null;
  }
}

const userInfo = sh('net.exe', ['user', acctName]);
if (userInfo) {
  pass(`本地账号 ${acctName} 存在`);
  // net user 的输出是本地化的，"账户启用"字段不好匹配；只看否定信号
  const admins = sh('net.exe', ['localgroup', 'Administrators']);
  if (admins === null) {
    skip('不在 Administrators 组', '读取组信息需要管理员权限');
  } else if (new RegExp(`^\\s*${acctName}\\s*$`, 'im').test(admins)) {
    fail('不在 Administrators 组', '它在这个组里，权限过高');
  } else {
    pass('不在 Administrators 组');
  }
} else {
  fail(`本地账号 ${acctName} 存在`, `net user ${acctName} 查不到`);
}

// ---- 5. 面板 ----

head('控制面板');
async function http(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(4000) });
  return { status: res.status, body: await res.text() };
}

let healthOk = false;
for (let i = 0; i < 5; i++) {
  try {
    const r = await http('/healthz');
    if (r.status === 200) {
      healthOk = true;
      let extra = '';
      try {
        const j = JSON.parse(r.body);
        extra = Object.entries(j)
          .filter(([, v]) => typeof v !== 'object')
          .slice(0, 4)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
      } catch {
        /* 不是 JSON 也说明服务活着 */
      }
      pass('/healthz 200', extra);
      break;
    }
    fail('/healthz 200', `HTTP ${r.status}`);
    break;
  } catch {
    await sleep(1000);
  }
}
if (!healthOk) fail('/healthz 200', `连不上 ${baseUrl}`);

if (healthOk) {
  try {
    const r = await http('/');
    if (r.status === 200 && /<html/i.test(r.body)) pass('首页可访问', `${r.body.length} 字节`);
    else fail('首页可访问', `HTTP ${r.status}`);
  } catch (e) {
    fail('首页可访问', e.message);
  }

  try {
    const r = await http('/api/settings');
    if (r.status === 401 || r.status === 403) pass('未登录被拒绝', `HTTP ${r.status}`);
    else warn('未登录被拒绝', `HTTP ${r.status}（预期 401/403）`);
  } catch (e) {
    warn('未登录被拒绝', e.message);
  }
}

// ---- 6. 端口 ----

head('端口');
const lanAddrs = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && !i.internal && (i.family === 'IPv4' || i.family === 4))
  .map((i) => i.address);

for (const [port, label, required] of [
  [5666, '面板 5666', true],
  [3001, '协议端 OneBot 3001', false],
  [6099, '协议端 WebUI 6099', false],
]) {
  const up = await tryConnect('127.0.0.1', port);
  if (!up) {
    if (required) fail(label, '本机连不上');
    else note(`${label}：未监听（协议端没启动时是正常的）`);
    continue;
  }
  if (!required) {
    pass(label, '本机可连');
    continue;
  }
  // 面板要求"只监听本机"：如果从本机的局域网地址也连得上，说明绑到了 0.0.0.0
  let exposed = '';
  for (const ip of lanAddrs) {
    if (await tryConnect(ip, port)) {
      exposed = ip;
      break;
    }
  }
  if (exposed !== '') warn(label, `从 ${exposed} 也能连上，说明对外网开放`);
  else pass(label, '本机可连，局域网地址连不上');
}

// ---- 7. 协议端 ----

head('协议端');
if (!probe?.task) {
  skip('计划任务 qqbot-napcat', '系统探测不可用');
} else if (!probe.task.exists) {
  warn('计划任务 qqbot-napcat', '不存在（未勾选协议端，或安装时没有已登录的桌面用户）');
} else {
  // Get-ScheduledTask 的 State 是枚举，PowerShell 转 JSON 后成了数字
  const TASK_STATE = ['Unknown', 'Disabled', 'Queued', 'Ready', 'Running'];
  const st = typeof probe.task.state === 'number' ? TASK_STATE[probe.task.state] ?? probe.task.state : probe.task.state;
  pass('计划任务 qqbot-napcat 已注册', `状态 ${st}`);
}

if (existsSync(join(root, 'napcat', 'napcat-run.cmd'))) pass('协议端 launcher 存在', 'napcat-run.cmd');
else if (existsSync(join(root, 'napcat', 'napcat.mjs'))) fail('协议端 launcher 存在', '缺 napcat-run.cmd，登录自启跑不起来');
else note('协议端未安装（安装时未勾选，或本机没有 QQ NT）');

// ---- 8. 系统登记 ----

head('系统登记');
if (!probe?.uninstall) {
  skip('已登记到"应用和功能"', '系统探测不可用');
} else if (probe.uninstall.version) {
  pass('已登记到"应用和功能"', `版本 ${probe.uninstall.version}`);
} else {
  fail('已登记到"应用和功能"', '注册表里没有卸载项');
}

// ---- 输出 ----

if (!quiet) process.stdout.write('\n── 结果\n');
let bad = 0;
for (const r of results) {
  if (r.state === 'FAIL') bad++;
  process.stdout.write(`  ${r.state.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}\n`);
}

const counts = results.reduce((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {});
process.stdout.write(
  `\n  ${counts.PASS ?? 0} 项通过${counts.WARN ? `，${counts.WARN} 项提醒` : ''}${counts.SKIP ? `，${counts.SKIP} 项跳过` : ''}${bad ? `，${bad} 项失败` : ''}\n`,
);

if (bad > 0 && !quiet) {
  process.stdout.write('\n  排查顺序：\n');
  process.stdout.write(`    1. ${join(root, 'logs')}\\${service}-svc.err.log 的最后 40 行\n`);
  process.stdout.write('    2. 开始菜单 →「重启 qqbot 服务」，再看一次\n');
  process.stdout.write('    3. 事件查看器 → Windows 日志 → 系统，来源 Service Control Manager\n');
}

if (denied > 0 && !quiet) {
  process.stdout.write(
    `\n  注：有 ${denied} 项因为目录 ACL 收紧而读不到。这是预期的安全设置，\n` +
      '      用管理员身份重新运行本脚本可以完整核对。\n',
  );
}

process.exit(bad > 0 ? 1 : 0);
