// 引导配置（etc/qqbot.toml）与密钥（etc/secrets.env）。
//
// 配置刻意分两层，与 Go 版一致：
//   - 引导配置：路径、监听地址、协议端连接串，部署期确定，面板不写
//   - 运行期设置（SQLite settings 表）：模型、人格、触发规则，面板可写、热生效
// 分开是为了避免面板写 TOML 时冲掉人工注释，也避免并发写竞态。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { LogLevel } from '../log/logger';

/**
 * 默认安装根目录。
 *
 * Linux 保留 /opt/qqbot（老安装都在那，改了等于让升级用户丢数据）。
 * Windows 必须换：'/opt/qqbot' 在 win32 上会被 Node 解析成「当前盘符:\opt\qqbot」，
 * 而服务账号对系统盘根目录没有写权限，症状是「服务一闪就停、日志里
 * unable to open database file」，非常难查。ProgramData 是 Windows 给
 * 机器级应用数据留的标准位置，安装器还会把 ACL 授给服务账号。
 */
const DEFAULT_ROOT =
  process.platform === 'win32'
    ? join(process.env.ProgramData?.trim() || 'C:\\ProgramData', 'qqbot')
    : '/opt/qqbot';

/** 默认监听地址（本机开发用）。Windows 安装版同样只绑本机，不再对外暴露。 */
const DEFAULT_LISTEN = '127.0.0.1:5666';

/** 默认 NapCat WebUI 地址。容器里曾由 compose 服务名覆盖。 */
const DEFAULT_NAPCAT_WEBUI = 'http://127.0.0.1:6099';

export interface Config {
  root: string;
  dataDir: string;
  log: { level: LogLevel; format: 'text' | 'json' };
  /** 展示/统计用的时区（IANA 名，如 Asia/Shanghai）。空串 = 跟随系统本地时区。 */
  time: { zone: string };
  onebot: { url: string; accessToken: string };
  panel: { listen: string };
  napcat: { webui: string };
}

/** 安装根目录，优先取 QQBOT_ROOT。 */
export function root(): string {
  const v = process.env.QQBOT_ROOT?.trim();
  return v && v !== '' ? v : DEFAULT_ROOT;
}

export function configPath(): string {
  return join(root(), 'etc', 'qqbot.toml');
}

/**
 * 前端静态资源目录（web/dist）。
 *
 * 为什么要在候选路径里找而不是写死一个：
 * 开发态用 tsx 直接跑源码，__dirname 是 src/config；
 * 生产态跑打包产物，__dirname 是 /app/dist。两者相对 web/dist
 * 的层级不同，写死任何一个都会在另一种模式下 404。
 * 按顺序取第一个真实存在的，两种模式都不用额外配置。
 */
export function webDir(): string {
  const env = process.env.QQBOT_WEB_DIR?.trim();
  if (env && env !== '') return env;

  const candidates = [
    resolve(process.cwd(), 'web', 'dist'),
    resolve(__dirname, '..', '..', 'web', 'dist'), // 源码态：src/config -> 仓库根
    resolve(__dirname, '..', 'web', 'dist'), // 打包态：dist/server.js -> /app/web/dist
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return candidates[candidates.length - 1]!;
}

/**
 * 密钥文件路径。
 *
 * 历史上安装脚本写的是 etc/env，而 Go 版读的是 etc/secrets.env；
 * 这里两个都认，优先 secrets.env，避免老安装读不到密钥。
 */
export function secretsPath(): string {
  const preferred = join(root(), 'etc', 'secrets.env');
  if (existsSync(preferred)) return preferred;
  const legacy = join(root(), 'etc', 'env');
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * 面板监听地址：环境变量 > TOML > 默认值。
 *
 * 环境变量压过 TOML 是刻意的——否则老安装里那份写着旧端口的 toml
 * 会让 compose 映射的新端口连不上，症状是「容器 healthy 但打不开」。
 */
function listenFromEnv(): string | undefined {
  const v = (process.env.QQBOT_LISTEN ?? process.env.QQBOT_PANEL_LISTEN)?.trim();
  return v && v !== '' ? v : undefined;
}

export function defaultConfig(): Config {
  const r = root();
  return {
    root: r,
    dataDir: join(r, 'data', 'qqbot'),
    log: { level: 'warn', format: 'text' },
    time: { zone: (process.env.QQBOT_TZ ?? '').trim() },
    onebot: { url: 'ws://127.0.0.1:3001', accessToken: '' },
    panel: { listen: listenFromEnv() ?? DEFAULT_LISTEN },
    napcat: { webui: DEFAULT_NAPCAT_WEBUI },
  };
}

const KNOWN_KEYS = new Set([
  'data_dir',
  'log',
  'log.level',
  'log.format',
  'time',
  'time.zone',
  'onebot',
  'onebot.url',
  'onebot.access_token',
  'panel',
  'panel.listen',
  'napcat',
  'napcat.webui',
]);

function collectUnknown(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (!KNOWN_KEYS.has(key)) out.push(key);
    else if (typeof v === 'object' && v !== null) out.push(...collectUnknown(v, key));
  }
  return out;
}

/**
 * 读取配置。文件不存在时返回默认配置并给出提示（不抛异常，方便 doctor 用）。
 * 返回值里的 warning 由调用方决定是否打印。
 */
export function loadConfig(path = configPath()): { config: Config; warning?: string } {
  const cfg = defaultConfig();
  if (!existsSync(path)) {
    // 配置文件不在也要校验时区：QQBOT_TZ 是环境变量进来的，不受 TOML 影响，
    // 写错时如果这里放行，错误会推迟到 configureZone 才以英文 ICU 报错抛出，
    // 用户看到的是 "Invalid time zone specified: Asia/Shangai"，根本不知道改哪。
    assertZone(cfg.time.zone);
    return {
      config: cfg,
      warning: `配置文件不存在: ${path}（先运行 qqbot install）`,
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`解析 ${path} 失败: ${(e as Error).message}`);
  }

  if (typeof doc.data_dir === 'string' && doc.data_dir !== '') {
    cfg.dataDir = doc.data_dir;
  }

  const log = doc.log as Record<string, unknown> | undefined;
  if (log) {
    if (typeof log.level === 'string' && log.level !== '') {
      cfg.log.level = log.level as LogLevel;
    }
    if (log.format === 'json' || log.format === 'text') {
      cfg.log.format = log.format;
    }
  }

  const onebot = doc.onebot as Record<string, unknown> | undefined;
  if (onebot) {
    if (typeof onebot.url === 'string') cfg.onebot.url = onebot.url;
    if (typeof onebot.access_token === 'string') cfg.onebot.accessToken = onebot.access_token;
  }

  // 时区：Windows 上 Node 直接忽略 TZ 环境变量，光靠 Docker 那套 TZ 是不行的，
  // 必须在配置里显式指定，否则 UTC 机器上的免打扰时段、峰时计价、按日统计全错。
  const time = doc.time as Record<string, unknown> | undefined;
  if (time && typeof time.zone === 'string') cfg.time.zone = time.zone.trim();
  const tzEnv = (process.env.QQBOT_TZ ?? '').trim();
  if (tzEnv !== '') cfg.time.zone = tzEnv;

  const panel = doc.panel as Record<string, unknown> | undefined;
  if (panel && typeof panel.listen === 'string' && panel.listen !== '') {
    cfg.panel.listen = panel.listen;
  }

  const napcat = doc.napcat as Record<string, unknown> | undefined;
  if (napcat && typeof napcat.webui === 'string' && napcat.webui !== '') {
    cfg.napcat.webui = napcat.webui;
  }

  // 归一化 + 校验
  if (cfg.dataDir === '') cfg.dataDir = join(cfg.root, 'data', 'qqbot');
  if (cfg.onebot.url.trim() === '') throw new Error('onebot.url 不能为空');
  // 方案必须显式校验：把 ws:// 手滑写成 http:// 时，new WebSocket 会在 dial() 里
  // 同步抛错，而 dial 的所有失败都被当成网络故障按 1s→30s 无限退避重连——
  // 日志里只有一条条"拨号失败"，运维会一直以为是协议端没起来。
  if (!/^wss?:\/\//i.test(cfg.onebot.url.trim())) {
    throw new Error(
      `onebot.url 必须以 ws:// 或 wss:// 开头（当前: ${cfg.onebot.url}）。` +
        '它是机器人主动连接协议端的 WebSocket 地址，不是 http 地址。',
    );
  }
  cfg.panel.listen = listenFromEnv() ?? (cfg.panel.listen || DEFAULT_LISTEN);

  // 时区名写错必须当场报错：静默退回 UTC 的症状是"机器人总在凌晨说话"，
  // 没人会想到是配置里多打了一个字母。
  assertZone(cfg.time.zone);

  // 协议端 WebUI 地址同样允许环境变量覆盖。
  // 容器里必须用 compose 服务名（http://napcat:6099）而不是 127.0.0.1，
  // 而配置文件是只读挂载的——用环境变量覆盖就不用为了换地址去改挂载文件。
  const webuiEnv = process.env.QQBOT_NAPCAT_WEBUI?.trim();
  if (webuiEnv && webuiEnv !== '') cfg.napcat.webui = webuiEnv;

  const unknown = collectUnknown(doc);
  const warning =
    unknown.length > 0 ? `警告: ${path} 中有未知配置项 ${unknown.join(', ')}，已忽略` : undefined;

  return { config: cfg, warning };
}

/** 把配置写回（安装脚本使用）。 */
export function saveConfig(cfg: Config, path = configPath()): void {
  const doc = {
    data_dir: cfg.dataDir,
    log: { level: cfg.log.level, format: cfg.log.format },
    time: { zone: cfg.time.zone },
    onebot: { url: cfg.onebot.url, access_token: cfg.onebot.accessToken },
    panel: { listen: cfg.panel.listen },
    napcat: { webui: cfg.napcat.webui },
  };
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, stringify(doc), { mode: 0o644 });
}

/** Intl 认不认这个时区名。不依赖列表硬编码，跟着 ICU 走。 */
export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 时区名非法时给一句能让用户直接照改的话，而不是 ICU 的英文原文。 */
function assertZone(zone: string): void {
  if (zone === '' || isValidZone(zone)) return;
  throw new Error(
    `time.zone 不是有效的时区名（当前: ${zone}）。` +
      '应填 IANA 名称，例如 Asia/Shanghai；留空则跟随系统时区。',
  );
}

/**
 * 密钥别名。
 *
 * 安装脚本与 compose 用的是短名（WEBUI_TOKEN），密钥盒里统一带 QQBOT_ 前缀。
 * 不归一的话，症状很隐蔽：面板能开、能登录，但「扫码」和「网络」两页
 * 永远显示未配置——因为服务端拿到的是空 token，而不是报错。
 */
const SECRET_ALIASES: Record<string, string> = {
  SECRET_KEY: 'QQBOT_SECRET_KEY',
  ONEBOT_TOKEN: 'QQBOT_ONEBOT_TOKEN',
  WEBUI_TOKEN: 'QQBOT_WEBUI_TOKEN',
};

/**
 * 读取密钥文件（KEY=VALUE 每行一条），并与进程环境合并。
 * 进程环境优先，便于 docker -e 覆盖。
 */
export function loadSecrets(path = secretsPath()): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (existsSync(path)) {
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      secrets[k] = v;
    }
  }
  for (const k of ['QQBOT_SECRET_KEY', 'QQBOT_ONEBOT_TOKEN', 'QQBOT_WEBUI_TOKEN']) {
    const v = process.env[k];
    if (v !== undefined && v !== '') secrets[k] = v;
  }
  for (const [alias, canonical] of Object.entries(SECRET_ALIASES)) {
    const env = process.env[alias];
    if (env !== undefined && env !== '') secrets[canonical] = env;
    if (secrets[canonical] === undefined && secrets[alias] !== undefined) {
      secrets[canonical] = secrets[alias];
    }
  }
  return secrets;
}
