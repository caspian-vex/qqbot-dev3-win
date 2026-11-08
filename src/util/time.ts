// 与 Go 标准库行为对齐的时间/格式工具。
//
// 面板前端是原样复用的，所以服务端输出的时间与时长必须与 Go 版逐字一致，
// 否则前端解析会出问题（例如把 uptime 当数字处理、把时间当 Date 解析失败）。

/** Go 的零值 time.Time 序列化结果。未连接/未发生的事件用它表示「没有」。 */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 展示用墙钟时区。
 *
 * 为什么需要它：Windows 上 Node **完全忽略 TZ 环境变量**（Linux 上有效），
 * 于是 Docker 时代那句 TZ=Asia/Shanghai 在 Windows 云主机上等于没写——
 * 机器是 UTC 时，免打扰时段会整体偏 8 小时、DeepSeek 峰时计价判断反了、
 * 按日用量统计把跨日切在下午 4 点。这些都不会报错，只会"表现得很奇怪"。
 *
 * 约定：空串 = 沿用系统本地时区，此时所有函数的行为与旧实现逐字一致
 * （已有测试断言 rfc3339 的偏移等于 getTimezoneOffset()，不能破坏）。
 */
let zoneName = '';
let partsFmt: Intl.DateTimeFormat | null = null;
let offsetFmt: Intl.DateTimeFormat | null = null;

export function configureZone(zone: string): void {
  const z = zone.trim();
  if (z === '') {
    zoneName = '';
    partsFmt = null;
    offsetFmt = null;
    return;
  }
  // 先构造一次，非法时区名当场抛错——由调用方转成可读的启动失败信息
  partsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: z,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'longOffset' });
  zoneName = z;
}

export function configuredZone(): string {
  return zoneName;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0=周日，与 Date.getDay() 一致，方便 isPeak 复用旧逻辑。 */
  dow: number;
}

/** 取目标时区下的墙钟字段；未配置时区时返回 null（调用方走老路径）。 */
function wallClock(d: Date): Wall | null {
  if (!partsFmt) return null;
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(d)) {
    if (x.type !== 'literal') p[x.type] = x.value;
  }
  const y = Number(p.year);
  const mo = Number(p.month);
  const day = Number(p.day);
  return {
    y,
    mo,
    d: day,
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
    dow: new Date(Date.UTC(y, mo - 1, day)).getUTCDay(),
  };
}

/** 该时刻在目标时区的偏移（分钟，东八区 = +480）。 */
function zoneOffset(d: Date): number {
  if (!offsetFmt) return -d.getTimezoneOffset();
  const name = offsetFmt.formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? '';
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  if (name === 'GMT' || name === 'UTC') return 0;
  // ICU 没给 longOffset 时，用「墙钟 - 真实时刻」反推
  const w = wallClock(d);
  if (!w) return -d.getTimezoneOffset();
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - d.getTime()) / 60000);
}

/**
 * 复刻 Go 的 time.Time JSON 序列化：RFC3339，带本地时区偏移，无小数秒。
 * 偏移为 0 时输出 "Z"（Go 的行为），否则输出 +08:00 这样的形式。
 */
export function rfc3339(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return ZERO_TIME;
  const w = wallClock(d);
  const offMin = w ? zoneOffset(d) : -d.getTimezoneOffset();
  const y = w ? w.y : d.getFullYear();
  const mo = w ? w.mo : d.getMonth() + 1;
  const day = w ? w.d : d.getDate();
  const h = w ? w.h : d.getHours();
  const mi = w ? w.mi : d.getMinutes();
  const s = w ? w.s : d.getSeconds();
  const base =
    `${y}-${pad2(mo)}-${pad2(day)}` + `T${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
  if (offMin === 0) return `${base}Z`;
  const sign = offMin > 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${base}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Unix 秒 → Date。 */
export function fromUnix(sec: number): Date {
  return new Date(sec * 1000);
}

/** 当前 Unix 秒。 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 复刻 Go 的 time.Duration.String()。
 *
 * 调用方（uptime）在 Go 里是 time.Since(start).Round(time.Second).String()，
 * 所以只需要处理整秒的情况：
 *   0      -> "0s"
 *   5      -> "5s"
 *   60     -> "1m0s"
 *   90     -> "1m30s"
 *   3600   -> "1h0m0s"
 *   3723   -> "1h2m3s"
 */
export function formatGoDuration(ms: number): string {
  const neg = ms < 0;
  // Round(time.Second) 的等价实现：四舍五入到整秒
  let total = Math.round(Math.abs(ms) / 1000);
  if (total === 0) return '0s';

  const sec = total % 60;
  total = Math.floor(total / 60);
  const min = total % 60;
  total = Math.floor(total / 60);
  const hour = total;

  let out: string;
  if (hour > 0) out = `${hour}h${min}m${sec}s`;
  else if (min > 0) out = `${min}m${sec}s`;
  else out = `${sec}s`;

  return neg ? `-${out}` : out;
}

/** 本地日期 "YYYY-MM-DD"，对应 Go 的 time.Now().Format("2006-01-02")。 */
export function localDay(d: Date = new Date()): string {
  const w = wallClock(d);
  if (w) return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 判断当前是否处于 DeepSeek 峰时（本地时区，周一至周五 9-12、14-18）。
 * 与原 Go 实现的 isPeak 一致。
 */
export function isPeak(now: Date = new Date()): boolean {
  const w = wallClock(now);
  const dow = w ? w.dow : now.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = w ? w.h : now.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 可被 abort 打断的 sleep，放在这里是因为它有好几个调用方。
 *
 * 关键在于**正常超时也要摘监听器**。`{ once: true }` 只在事件真的触发时
 * 才移除监听，而传进来的 signal 往往是进程级的（main 的 ac.signal 活到退出），
 * 于是每条消息的分段间隔、每次未登录时的 5 秒轮询都会往它上面挂一个
 * 永不释放的闭包：跑一天就是上万个，同时触发 Node 的 MaxListeners 告警。
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
