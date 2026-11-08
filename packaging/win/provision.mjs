// 安装期的配置生成器。由 installer.nsi 在文件落盘之后调用，跑在内置的 node.exe 上。
//
// 为什么不在 NSIS 里直接写这些文件：NSIS 没有加密安全的随机数、没有 JSON 处理、
// 写 UTF-16 还得自己拼 BOM。三样都是"写错了要到运行时才发现"的类型。交给 node
// 之后，同一份逻辑还能在本机直接跑测试（见 packaging/win/test-provision.mjs）。
//
// 幂等约定（升级时最重要）：
//   etc/secrets.env      已存在就一个字节都不改 —— 改了等于丢掉模型 API Key 的解密密钥
//   etc/qqbot.toml       已存在就不动 —— 用户可能自己改过端口/时区
//   service-account.json 已存在就复用 —— 否则服务账号口令和已注册的服务对不上
//   service/qqbot-svc.xml 每次都重写 —— 它只描述"怎么跑"，与用户数据无关
//   napcat/config/*.json 只在缺失时生成 —— 用户可能在 WebUI 里调过网络配置
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const appDir = resolve(arg('app', process.cwd()));
const root = resolve(arg('root', join(process.env.ProgramData ?? 'C:\\ProgramData', 'qqbot')));
const panelListen = arg('panel-listen', '127.0.0.1:5666');
const timeZone = arg('timezone', 'Asia/Shanghai');
const serviceName = arg('service', 'qqbot');
const wantNapcat = flag('napcat');

// precheck.ps1 的产物。用它拿"真正登录桌面的人"——安装器是提权跑的，
// 环境变量里的 USERNAME 可能是管理员账号而不是在用的那个，计划任务的
// LogonTrigger 认错了人，协议端就永远不启动。
let precheck = null;
const precheckPath = arg('precheck', '');
if (precheckPath !== '' && existsSync(precheckPath)) {
  try {
    precheck = JSON.parse(readFileSync(precheckPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    precheck = null;
  }
}

const taskUser = arg(
  'task-user',
  precheck?.taskUser || (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : ''),
);

const hex = (n) => randomBytes(n).toString('hex');
const toPosix = (p) => p.replace(/\\/g, '/');
const log = (msg) => process.stdout.write(`  ${msg}\n`);

// ---- 目录 ----

const dirs = [
  join(root, 'etc'),
  join(root, 'data', 'qqbot', 'images'),
  join(root, 'logs'),
  join(root, 'backup'),
];
for (const d of dirs) mkdirSync(d, { recursive: true });
log(`目录就绪: ${root}`);

// ---- 密钥（生成一次，之后永不覆盖） ----

const secretsPath = join(root, 'etc', 'secrets.env');
const secrets = {};
if (existsSync(secretsPath)) {
  for (const line of readFileSync(secretsPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (s === '' || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i > 0) secrets[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
}

let secretsChanged = false;
/** 缺哪个补哪个：老安装里可能只有 SECRET_KEY，升级后需要 WEBUI_TOKEN。 */
function ensureSecret(key, bytes) {
  if ((secrets[key] ?? '') !== '') return;
  secrets[key] = hex(bytes);
  secretsChanged = true;
}
ensureSecret('QQBOT_SECRET_KEY', 32); // 64 位 hex，Box.fromHex 要求
ensureSecret('QQBOT_ONEBOT_TOKEN', 16); // 32 位 hex，与 onebot/token.ts 的 TOKEN_BYTES 一致
ensureSecret('QQBOT_WEBUI_TOKEN', 16);

if (secretsChanged || !existsSync(secretsPath)) {
  const body =
    '# qqbot 密钥文件。这四行丢了就等于丢数据，请一并备份。\n' +
    '# 改动后需要重启 qqbot 服务才生效。\n' +
    `QQBOT_SECRET_KEY=${secrets.QQBOT_SECRET_KEY}\n` +
    `QQBOT_ONEBOT_TOKEN=${secrets.QQBOT_ONEBOT_TOKEN}\n` +
    `QQBOT_WEBUI_TOKEN=${secrets.QQBOT_WEBUI_TOKEN}\n`;
  writeFileSync(secretsPath, body, { mode: 0o600 });
  log('已生成 etc\\secrets.env');
} else {
  log('etc\\secrets.env 已存在，保持原样');
}

// ---- 引导配置 ----

const tomlPath = join(root, 'etc', 'qqbot.toml');
if (existsSync(tomlPath)) {
  log('etc\\qqbot.toml 已存在，保持原样');
} else {
  // 全部用正斜杠：TOML 的 Windows 路径写反斜杠要转义成 \\，用户手改时极易写错。
  const toml = `# qqbot 引导配置。改动后需要重启 qqbot 服务才生效。
# 运行期的设置（模型、人格、触发规则）不在这里，在面板里改、保存即生效。

data_dir = "${toPosix(join(root, 'data', 'qqbot'))}"

[log]
level = "info"
format = "text"

# Windows 上 Node 会忽略 TZ 环境变量，时区必须在这里写死。
# 留空（""）表示跟随系统时区。
[time]
zone = "${timeZone}"

[onebot]
url = "ws://127.0.0.1:3001"
# 令牌由服务端托管（在 etc/secrets.env 里），这里留空。
access_token = ""

[panel]
# 只绑本机：面板从这台机器上的浏览器打开。要给局域网用就改成 "0.0.0.0:5666"。
listen = "${panelListen}"

[napcat]
webui = "http://127.0.0.1:6099"
`;
  writeFileSync(tomlPath, toml, { mode: 0o644 });
  log('已生成 etc\\qqbot.toml');
}

// ---- 服务账号口令 ----

const acctPath = join(root, 'etc', 'service-account.json');
let acct;
if (existsSync(acctPath)) {
  acct = JSON.parse(readFileSync(acctPath, 'utf8'));
  log(`服务账号口令已存在（${acct.account}）`);
} else {
  acct = { account: 'qqbot_svc', password: hex(16) + hex(4), created: new Date().toISOString() };
  mkdirSync(dirname(acctPath), { recursive: true });
  writeFileSync(acctPath, `${JSON.stringify(acct, null, 2)}\n`, { mode: 0o600 });
  log('已生成服务账号口令');
}

// ---- WinSW 服务定义 ----

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const svcDir = join(appDir, 'service');
mkdirSync(svcDir, { recursive: true });
const svcXml = `<!-- 由 provision.mjs 生成，每次安装/升级都会重写。
     不要手工改这里：改 qqbot.toml 与 secrets.env，这两个文件才是给用户改的。 -->
<service>
  <id>${xml(serviceName)}</id>
  <name>${xml(serviceName)}</name>
  <description>QQ 机器人（面板 http://${xml(panelListen)}）</description>

  <executable>${xml(join(appDir, 'node', 'node.exe'))}</executable>
  <arguments>dist\\server.js run</arguments>
  <workingdirectory>${xml(appDir)}</workingdirectory>
  <hidewindow>true</hidewindow>

  <env name="QQBOT_ROOT" value="${xml(root)}"/>
  <env name="NODE_ENV" value="production"/>

  <!-- 开机自动启动，但延迟 2 分钟：开机瞬间 Defender 与 QQ 会抢 CPU，
       立刻起服务经常出现首次连不上协议端。 -->
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>

  <!-- 专用低权限本地账号：机器人自带的"电脑操作"能跑命令，
       用 LocalSystem 等于把整机管理员权限交给模型。 -->
  <serviceaccount>
    <username>.\\${xml(acct.account)}</username>
    <password>${xml(acct.password)}</password>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>

  <!-- stdout/stderr 落文件并按大小轮转：Windows 服务没有控制台，
       不接管输出的话日志等于全丢（面板里的环形缓冲一重启就没了）。 -->
  <log mode="roll-by-size">
    <logpath>${xml(join(root, 'logs'))}</logpath>
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>

  <!-- 崩溃重启节流：10s→30s→60s，一小时内没再挂就重置计数。
       配置写错时最多重启三次就停在 Stopped，不会无限重启刷爆日志。 -->
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>

  <!-- 停止时先发 Ctrl+C（Node 收到 SIGINT 会走优雅关闭），20 秒后强杀进程树 -->
  <stoptimeout>20 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
</service>
`;
writeFileSync(join(svcDir, `${serviceName}-svc.xml`), svcXml, 'utf8');
log('已生成 service\\qqbot-svc.xml');

// ---- NapCat 配置与计划任务 ----

const napcatDir = join(root, 'napcat');
if (wantNapcat && existsSync(join(napcatDir, 'napcat.mjs'))) {
  const cfgDir = join(napcatDir, 'config');
  mkdirSync(cfgDir, { recursive: true });

  const webuiCfg = join(cfgDir, 'webui.json');
  if (!existsSync(webuiCfg)) {
    writeFileSync(
      webuiCfg,
      `${JSON.stringify({ host: '127.0.0.1', port: 6099, token: secrets.QQBOT_WEBUI_TOKEN, loginRate: 3 }, null, 2)}\n`,
    );
    log('已生成 napcat\\config\\webui.json');
  }

  // 写 onebot11.json 而不是 onebot11_<QQ号>.json：安装时还不知道要登录哪个号。
  // NapCat 4.5.3+ 把它当作默认配置，登录后自己落成 onebot11_<uin>.json。
  const obCfg = join(cfgDir, 'onebot11.json');
  if (!existsSync(obCfg)) {
    const doc = {
      network: {
        httpServers: [],
        httpClients: [],
        websocketServers: [
          {
            name: 'qqbot',
            enable: true,
            host: '127.0.0.1',
            port: 3001,
            messagePostFormat: 'array',
            reportSelfMessage: false,
            token: secrets.QQBOT_ONEBOT_TOKEN,
            enableForcePushEvent: true,
            debug: false,
            heartInterval: 30000,
          },
        ],
        websocketClients: [],
      },
      musicSignUrl: '',
      enableLocalFile2Url: false,
      parseMultMsg: false,
    };
    writeFileSync(obCfg, `${JSON.stringify(doc, null, 2)}\n`);
    log('已生成 napcat\\config\\onebot11.json（3001 已与令牌对齐）');
  }

  const napcatCfg = join(cfgDir, 'napcat.json');
  if (!existsSync(napcatCfg)) {
    writeFileSync(
      napcatCfg,
      `${JSON.stringify({ fileLog: true, consoleLog: false, fileLogLevel: 'info', consoleLogLevel: 'info', packetServer: '' }, null, 2)}\n`,
    );
  }

  // 计划任务：登录后自启，RunLevel=HighestAvailable（NapCat 注入 QQ 需要管理员，
  // 但任务里不弹 UAC）。用 XML 而不是 schtasks 命令行，是因为 /TR 一行塞不下引号。
  if (taskUser !== '') {
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>qqbot 协议端（NapCat），登录后自动启动</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(taskUser)}</UserId>
      <Delay>PT20S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(taskUser)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(join(napcatDir, 'napcat-run.cmd'))}</Command>
      <WorkingDirectory>${xml(napcatDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
    // schtasks /XML 只认 UTF-16LE（带 BOM）或 UTF-8(带 BOM)；UTF-16LE 最稳。
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, 'utf16le')]);
    writeFileSync(join(napcatDir, 'qqbot-napcat.task.xml'), buf);
    log(`已生成计划任务定义（用户: ${taskUser}）`);
  } else {
    log('未识别到交互登录用户，跳过计划任务（可在安装后手动运行安装包）');
  }
} else if (wantNapcat) {
  log('警告: napcat 目录不完整，跳过协议端配置');
}

log('配置生成完成');
