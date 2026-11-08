// 带重试与镜像回退的下载器。
//
// 单独成文件的原因有两条：
//   1. 这段逻辑必须能脱离整个构建流程被测试（构建一次要几分钟，改重试策略不能靠它验证）；
//   2. 它踩过的坑值得单独记下来 —— 见下面的注释。
//
// 为什么用 node 自带的 https 而不是 curl：Windows 上的 curl 是 schannel 版，拉 GitHub
// 的 release 二进制偶发 "server closed abruptly"；node 的 TLS 实现没有这个毛边。
//
// 为什么要重试：GitHub Release 的下载地址会 302 到 objects.githubusercontent.com，
// 而该域名对同一出口 IP 有速率限制，超了直接 503。这个 503 是瞬时的 —— 等十几秒再
// 来一次就好，但在 CI 上没人重试，整条流水线就红了（实测首次跑 CI 就是这么挂的）。
// 所以：5xx / 429 / 连接类错误都退避重试，4xx 和校验失败则立刻换源。
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { basename } from 'node:path';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODE = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这个错误值得再试一次吗（同一地址），还是该换下一个源？ */
export function isTransient(e) {
  if (!e) return false;
  if (typeof e.status === 'number') return RETRYABLE_STATUS.has(e.status);
  if (e.code && RETRYABLE_CODE.has(e.code)) return true;
  return /socket hang up|timeout|aborted|ECONNRESET/i.test(e.message ?? '');
}

/** 候选地址：官方优先，国内/CI 出口被限流时退到镜像。 */
export function sourcesFor(url) {
  const list = [url];
  if (/^https:\/\/github\.com\//.test(url)) {
    list.push(`https://gh-proxy.com/${url}`);
    list.push(`https://ghproxy.net/${url}`);
  }
  return list;
}

export async function download(url, dest, opts = {}) {
  const { attempts = 3, log = () => {}, backoffMs = 2000 } = opts;
  const failures = [];

  for (const src of sourcesFor(url)) {
    for (let round = 1; round <= attempts; round += 1) {
      try {
        await downloadOnce(src, dest, opts);
        return;
      } catch (e) {
        failures.push(`${src} 第 ${round} 次：${e.message}`);
        if (!isTransient(e)) {
          // 404、大小/哈希不符这类问题重试没有意义，直接换源
          log(`${basename(dest)}：${e.message}（换源）`);
          break;
        }
        if (round < attempts) {
          const wait = backoffMs * round;
          log(`${basename(dest)}：${e.message}，${wait / 1000}s 后重试`);
          await sleep(wait);
        }
      }
    }
  }

  throw new Error(`无法下载 ${basename(dest)}\n    ${failures.join('\n    ')}`);
}

function downloadOnce(url, dest, { expectSize = 0, sha256 = '', log = () => {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const go = (u, depth = 0) => {
      if (depth > 6) {
        rejectP(new Error('重定向次数过多'));
        return;
      }

      // 镜像里 http 的也有（部分代理只给 http），按协议选模块
      const getter = u.startsWith('http://') ? httpGet : httpsGet;
      getter(u, { timeout: 60_000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          go(res.headers.location, depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          rejectP(err);
          return;
        }

        mkdirSync(dest.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
        const tmp = `${dest}.part`;
        const out = createWriteStream(tmp);
        const hash = createHash('sha256');
        let got = 0;
        let lastTick = 0;

        res.on('data', (c) => {
          got += c.length;
          hash.update(c);
          const mb = Math.floor(got / (5 * 1024 * 1024));
          if (mb > lastTick) {
            lastTick = mb;
            process.stdout.write(`\r   ${basename(dest)} ${mb} MB...`);
          }
        });
        res.pipe(out);

        out.on('finish', () => {
          process.stdout.write('\r');
          const size = statSync(tmp).size;
          if (expectSize > 0 && size !== expectSize) {
            rmSync(tmp, { force: true });
            rejectP(new Error(`大小不符（期望 ${expectSize}，实际 ${size}）`));
            return;
          }
          if (sha256 !== '' && hash.digest('hex') !== sha256) {
            rmSync(tmp, { force: true });
            rejectP(new Error('sha256 不符'));
            return;
          }
          rmSync(dest, { force: true });
          // 用 rename 跨设备会失败，同盘直接复制，成本可忽略
          copyFileSync(tmp, dest);
          rmSync(tmp, { force: true });
          log(`${basename(dest)} 就绪（${(size / 1048576).toFixed(1)} MB）`);
          resolveP();
        });
        out.on('error', rejectP);
        res.on('aborted', () => rejectP(Object.assign(new Error('连接中断'), { code: 'ECONNRESET' })));
        res.on('error', rejectP);
      }).on('error', rejectP);
    };

    go(url);
  });
}
