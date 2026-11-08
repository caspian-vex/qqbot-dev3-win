// 打包期下载器的回归测试。
//
// 为什么要专门测这段：CI 第一次跑发布流水线就挂在这里 —— GitHub Release 的 asset
// 地址会 302 到 objects.githubusercontent.com，出口 IP 被限流时直接返回 503。
// 下载器当时只试一次，整条流水线因此变红，而本地构建（有 vendor 缓存或网络更宽松）
// 完全看不出问题。所以把「5xx 要退避重试」「4xx 别浪费时间」「GitHub 地址要有镜像」
// 这三条规则钉成测试。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// 打包脚本是 .mjs 且没有类型声明：用变量化的动态 import，避免污染 tsc 的类型解析
const moduleUrl = pathToFileURL(join(__dirname, '..', 'packaging', 'win', 'fetch.mjs')).href;

/* eslint-disable @typescript-eslint/no-explicit-any */
let cached: any;
async function fetchMod(): Promise<any> {
  if (!cached) cached = await import(moduleUrl);
  return cached;
}

interface Harness {
  download: (url: string, dest: string, opts?: Record<string, unknown>) => Promise<void>;
  dir: string;
  hits: () => number;
  close: () => Promise<void>;
}

/** 起一个能被脚本指定响应序列的本地 HTTP 服务。 */
async function harness(statuses: number[], body = 'hello'): Promise<Harness> {
  const { download } = await fetchMod();
  let count = 0;
  const server = createServer((_req, res) => {
    const status = statuses[Math.min(count, statuses.length - 1)] ?? 500;
    count += 1;
    if (status === 200) {
      res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(status, { 'content-length': 4 });
    res.end('nope');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('拿不到端口');
  const base = `http://127.0.0.1:${addr.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-fetch-'));

  return {
    download: (path, dest, opts = {}) => download(`${base}${path}`, dest, { backoffMs: 5, log: () => {}, ...opts }),
    dir,
    hits: () => count,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('503 会退避重试，最终拿到文件', async () => {
  const h = await harness([503, 503, 200]);
  try {
    await h.download('/asset.bin', join(h.dir, 'asset.bin'));
    assert.equal(readFileSync(join(h.dir, 'asset.bin'), 'utf8'), 'hello');
    assert.equal(h.hits(), 3, '应该是第三次才成功');
  } finally {
    await h.close();
  }
});

test('一直 503 时重试到上限就放弃，并带上失败原因', async () => {
  const h = await harness([503]);
  try {
    await assert.rejects(() => h.download('/asset.bin', join(h.dir, 'asset.bin')), (err: Error) => {
      assert.match(err.message, /无法下载 asset\.bin/);
      assert.match(err.message, /HTTP 503/);
      return true;
    });
    // 默认 3 次；不重试镜像（这个地址不是 github.com）
    assert.equal(h.hits(), 3);
  } finally {
    await h.close();
  }
});

test('404 不重试，立刻失败', async () => {
  const h = await harness([404]);
  try {
    await assert.rejects(() => h.download('/asset.bin', join(h.dir, 'asset.bin')));
    assert.equal(h.hits(), 1, '4xx 重试没有意义，应该只请求一次');
  } finally {
    await h.close();
  }
});

test('大小不符时丢弃半成品，不会留下可用的假文件', async () => {
  const h = await harness([200], 'hello');
  try {
    await assert.rejects(() => h.download('/asset.bin', join(h.dir, 'asset.bin'), { expectSize: 999 }));
    assert.throws(() => readFileSync(join(h.dir, 'asset.bin')), '文件不该存在');
  } finally {
    await h.close();
  }
});

test('GitHub 地址会附带镜像候选，其他地址不会', async () => {
  const { sourcesFor } = await fetchMod();
  const gh = sourcesFor('https://github.com/o/r/releases/download/v1/x.exe');
  assert.equal(gh[0], 'https://github.com/o/r/releases/download/v1/x.exe');
  assert.ok(gh.length >= 2, '至少要有官方 + 一个镜像');
  assert.ok(
    gh.slice(1).every((u: string) => u.endsWith('github.com/o/r/releases/download/v1/x.exe')),
    '镜像应保留完整路径',
  );

  const other = sourcesFor('https://nodejs.org/dist/v22.22.2/win-x64/node.exe');
  assert.deepEqual(other, ['https://nodejs.org/dist/v22.22.2/win-x64/node.exe']);
});

test('可重试与不可重试的错误分类正确', async () => {
  const { isTransient } = await fetchMod();
  assert.equal(isTransient(Object.assign(new Error('HTTP 503'), { status: 503 })), true);
  assert.equal(isTransient(Object.assign(new Error('HTTP 429'), { status: 429 })), true);
  assert.equal(isTransient(Object.assign(new Error('HTTP 404'), { status: 404 })), false);
  assert.equal(isTransient(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransient(new Error('sha256 不符')), false);
  assert.equal(isTransient(new Error('大小不符（期望 1，实际 2）')), false);
});
