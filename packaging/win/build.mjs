// Windows 安装包构建编排。
//
// 一条命令做完全部事情：下依赖 → 构建前端产物 → 裁剪 NapCat → staging → 调 makensis。
// 为什么不用 Docker/electron-builder 那套：这个项目运行期只有"node.exe + 两个 js + 静态页"，
// 用 NSIS 直接拼装出来的包最小也最可控（不用先装 Node、不用装 NSIS —— 便携版就够了）。
//
// 用法：
//   node packaging/win/build.mjs                    # 完整构建
//   node packaging/win/build.mjs --skip-tests       # 跳过测试（只调样式时用）
//   node packaging/win/build.mjs --no-napcat        # 不打包协议端
//   node packaging/win/build.mjs --version 0.10.1
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:https';
import { basename, join, relative, resolve } from 'node:path';
import { normalizeTree } from './normalize.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const BUILD = join(REPO, 'build');
const VENDOR = join(REPO, 'vendor');
const STAGE = join(BUILD, 'stage');
const OUT = join(REPO, 'dist-win');

/** 外部资源版本。改这里就等于改发布内容，务必同步 README 与 CHANGELOG。 */
const NODE_VERSION = 'v22.22.2';
const NAPCAT_VERSION = 'v4.18.42';
const WINSW_VERSION = 'v2.12.0';

const argv = process.argv.slice(2);
const flagOn = (n) => argv.includes(`--${n}`);
function arg(name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const version = arg('version', pkg.version);
const commit = arg('commit', gitShort());
const buildDate = new Date().toISOString();
const wantNapcat = !flagOn('no-napcat');

function gitShort() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

function step(msg) {
  process.stdout.write(`\n== ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`   ${msg}\n`);
}

// ---- 下载 ----

/**
 * 下载并校验大小。
 *
 * 用 node 自带的 https 而不是 curl：这台机器的 Git Bash 里 curl 是 schannel 版，
 * 拉 GitHub 的 release 二进制偶发 "server closed abruptly"；node 的 TLS 实现没有这个毛边。
 * 另外 GitHub Release 在国内经常被中间设备掐断，所以留了镜像兜底。
 */
function download(url, dest, opts = {}) {
  const tries = [url];
  if (url.includes('github.com/')) tries.push(`https://gh-proxy.com/${url}`);

  for (const u of tries) {
    try {
      return downloadOnce(u, dest, opts);
    } catch (e) {
      info(`下载失败（${basename(dest)}）: ${e.message}`);
    }
  }
  throw new Error(`无法下载 ${url}`);
}

function downloadOnce(url, dest, { expectSize = 0, sha256 = '' } = {}) {
  return new Promise((resolveP, rejectP) => {
    const go = (u, depth = 0) => {
      if (depth > 6) {
        rejectP(new Error('重定向次数过多'));
        return;
      }
      get(u, { timeout: 60_000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          go(res.headers.location, depth + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          rejectP(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        mkdirSync(join(dest, '..'), { recursive: true });
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
          // 用 rename 会跨设备失败时再退化，这里直接复制（同盘，成本可忽略）
          copyFileSync(tmp, dest);
          rmSync(tmp, { force: true });
          info(`${basename(dest)} 就绪（${(size / 1048576).toFixed(1)} MB）`);
          resolveP();
        });
        out.on('error', rejectP);
      }).on('error', rejectP);
    };
    go(url);
  });
}

async function fetchVendor() {
  step('准备外部资源');
  mkdirSync(VENDOR, { recursive: true });

  const nodeExe = join(VENDOR, 'node.exe');
  if (!existsSync(nodeExe) || statSync(nodeExe).size !== 87074816) {
    await download(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`, nodeExe, {
      expectSize: 87074816,
    });
  } else {
    info('node.exe 已存在');
  }

  const winsw = join(VENDOR, 'WinSW-x64.exe');
  if (!existsSync(winsw) || statSync(winsw).size < 1_000_000) {
    await download(
      `https://github.com/winsw/winsw/releases/download/${WINSW_VERSION}/WinSW-x64.exe`,
      winsw,
      { expectSize: 18243033 },
    );
  } else {
    info('WinSW-x64.exe 已存在');
  }

  if (wantNapcat) {
    const zip = join(VENDOR, 'NapCat.Shell.zip');
    if (!existsSync(zip) || statSync(zip).size < 30_000_000) {
      await download(
        `https://github.com/NapNeko/NapCatQQ/releases/download/${NAPCAT_VERSION}/NapCat.Shell.zip`,
        zip,
        { expectSize: 35967555 },
      );
    } else {
      info('NapCat.Shell.zip 已存在');
    }
  }

  const nsisDir = join(BUILD, 'nsis', 'nsis-3.11');
  if (!existsSync(join(nsisDir, 'makensis.exe'))) {
    const zip = join(VENDOR, 'nsis-3.11.zip');
    if (!existsSync(zip) || statSync(zip).size < 2_000_000) {
      // SourceForge 的 prdownloads 会 302 到一个挑镜像的页面，downloads.* 才是文件
      await download('https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip', zip, {
        expectSize: 2361546,
      });
    }
    extractZip(zip, join(BUILD, 'nsis'));
    info('NSIS 便携版已解压');
  } else {
    info('NSIS 已就绪');
  }
}

/**
 * 解压 zip。
 *
 * 必须用 System32 的 tar（bsdtar）：Git Bash 自带的 tar 是 GNU tar 1.35，
 * 对 zip 只会报 "This does not look like a tar archive"，而 Windows 上没有 7z。
 */
function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(bsdtar, ['-xf', zip, '-C', dest], { stdio: 'inherit' });
}

// ---- 构建 ----

function run(cmd, args, opts = {}) {
  info(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: REPO, stdio: 'inherit', ...opts });
}

function buildApp() {
  step('构建程序本体');
  const env = { ...process.env, QQBOT_VERSION: version, QQBOT_COMMIT: commit, QQBOT_BUILD_DATE: buildDate };
  run('npm', ['run', 'typecheck'], { env, shell: true });
  if (!flagOn('skip-tests')) run('npm', ['test'], { env, shell: true });
  run('npm', ['run', 'build'], { env, shell: true });

  for (const f of ['dist/server.js', 'dist/argon-worker.js', 'web/dist/index.html', 'web/dist/app.js']) {
    if (!existsSync(join(REPO, f))) throw new Error(`构建产物缺失: ${f}`);
  }
  info(`dist/server.js ${(statSync(join(REPO, 'dist/server.js')).size / 1024).toFixed(0)} KB`);
}

// ---- NapCat 裁剪 ----

/**
 * 只留 Windows x64 的原生模块。
 *
 * NapCat 的发布包里塞了全平台的 .node：ffmpeg 30MB、napi2native 67MB、packet 2.7MB…
 * 其中 95% 在这台机器上永远不会被加载。裁掉之后安装包能小 20-30MB，
 * 用户下载和解压的时间都是真金白银。
 */
function trimNapcat(dir) {
  const native = join(dir, 'native');
  if (!existsSync(native)) return;
  let removed = 0;

  const keepName = (name) => /win32[.-]x64/i.test(name) || name === 'ffmpeg.dll';

  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
      } else if (!keepName(name)) {
        removed += st.size;
        rmSync(p, { force: true });
      }
    }
  };
  walk(native);
  info(`裁剪非 win32-x64 原生模块：省 ${(removed / 1048576).toFixed(0)} MB`);
}

function checkNapcat(dir) {
  const must = [
    'napcat.mjs',
    'NapCatWinBootMain.exe',
    'NapCatWinBootHook.dll',
    'loadNapCat.js',
    'qqnt.json',
    'native/packet/MoeHoo.win32.x64.node',
  ];
  for (const f of must) {
    if (!existsSync(join(dir, f))) throw new Error(`NapCat 缺少关键文件: ${f}`);
  }
  const size = statSync(join(dir, 'napcat.mjs')).size;
  if (size < 3_000_000) throw new Error(`napcat.mjs 大小异常（${size}），解压可能不完整`);
}

// ---- staging ----

/**
 * 拿一个空目录，优先复用固定路径。
 *
 * 为什么要 try/catch：有些环境（含本仓库的开发机）对"一次删掉上百个文件"有安全闸，
 * rmSync 递归删 stage 会被拦下。拦下时退化成带时间戳的新目录，
 * 保证这一轮构建用到的目录一定是干净的，旧目录留给人工清理（已在 .gitignore 里）。
 */
function freshDir(base) {
  try {
    rmSync(base, { recursive: true, force: true });
    return base;
  } catch (e) {
    const alt = `${base}-${Date.now().toString(36)}`;
    info(`旧目录删不掉（${e.code ?? 'EUNKNOWN'}），改用 ${relative(REPO, alt)}`);
    return alt;
  }
}

function stage() {
  step('准备 staging');
  // 先归一化源码里的原生脚本：.ps1/.nsi 缺 BOM、.cmd 用了 LF，
  // 都会变成"运行时才炸"的问题，放在这里一次做掉。
  normalizeTree(join(REPO, 'packaging', 'win'), { log: info });

  const stageDir = freshDir(STAGE);
  const app = join(stageDir, 'app');
  const dirs = ['dist', 'web/dist', 'node', 'service', 'tools', 'assets'];
  for (const d of dirs) mkdirSync(join(app, d), { recursive: true });

  copyFileSync(join(REPO, 'dist/server.js'), join(app, 'dist/server.js'));
  copyFileSync(join(REPO, 'dist/argon-worker.js'), join(app, 'dist/argon-worker.js'));
  for (const f of ['index.html', 'app.js', 'style.css', 'theme.js']) {
    copyFileSync(join(REPO, 'web/dist', f), join(app, 'web/dist', f));
  }
  copyFileSync(join(VENDOR, 'node.exe'), join(app, 'node/node.exe'));
  copyFileSync(join(VENDOR, 'WinSW-x64.exe'), join(app, 'service/qqbot-svc.exe'));

  for (const f of ['provision.mjs', 'wait-credential.mjs', 'set-service-account.mjs', 'precheck.ps1', 'account.ps1']) {
    copyFileSync(join(REPO, 'packaging/win', f), join(app, 'tools', f));
  }
  for (const f of ['qqbot.cmd', 'restart-service.cmd', 'start-napcat.cmd']) {
    copyFileSync(join(REPO, 'packaging/win', f), join(app, f));
  }

  const ico = join(REPO, 'packaging/win/assets/qqbot.ico');
  if (!existsSync(ico)) throw new Error('缺少 packaging/win/assets/qqbot.ico（运行 make-icon.mjs）');
  mkdirSync(join(app, 'assets'), { recursive: true });
  copyFileSync(ico, join(app, 'assets/qqbot.ico'));

  writeFileSync(
    join(app, 'VERSION'),
    `qqbot ${version}\ncommit ${commit}\nbuilt ${buildDate}\nnode ${NODE_VERSION}\nnapcat ${wantNapcat ? NAPCAT_VERSION : '(not bundled)'}\n`,
  );
  copyFileSync(join(REPO, 'packaging/win/README-win.txt'), join(app, 'README-win.txt'));
  writeFileSync(
    join(app, 'LICENSE.txt'),
    'qqbot 安装包声明\n\n' +
      '本项目代码：见仓库 LICENSE。\n' +
      `内置 Node.js ${NODE_VERSION}：MIT，https://nodejs.org\n` +
      `内置 WinSW ${WINSW_VERSION}：MIT，https://github.com/winsw/winsw\n` +
      (wantNapcat ? `内置 NapCat ${NAPCAT_VERSION}：见 https://github.com/NapNeko/NapCatQQ\n` : '') +
      '\nNapCat 是一个独立项目，通过注入方式加载官方 QQ NT 客户端；\n' +
      '它不会被本安装包修改，也不属于本项目。\n',
  );

  if (wantNapcat) {
    const dst = join(stageDir, 'napcat');
    mkdirSync(dst, { recursive: true });
    copyTree(join(BUILD, 'napcat'), dst);
    // 计划任务的 <Command> 指向 napcat 目录里的这个 launcher（见 provision.mjs），
    // 它不是 NapCat 官方包里的文件，漏拷的话任务建好了却跑不起来。
    copyFileSync(join(REPO, 'packaging/win/napcat-run.cmd'), join(dst, 'napcat-run.cmd'));
    checkNapcat(dst);
    info('NapCat 已就位并校验通过');
  }

  info(`staging 完成: ${relative(REPO, stageDir)}`);
  return stageDir;
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

// ---- 打包 ----

function makeInstaller(stageDir) {
  step('生成安装包');
  mkdirSync(OUT, { recursive: true });
  const makensis = join(BUILD, 'nsis', 'nsis-3.11', 'makensis.exe');
  const args = [
    `/DAPP_VERSION=${version}`,
    `/DSTAGE=${stageDir.replace(/\\/g, '/')}`,
    `/DOUTDIR=${OUT.replace(/\\/g, '/')}`,
    `/DHAVE_NAPCAT=${wantNapcat ? 1 : 0}`,
    '-V2',
    join(REPO, 'packaging/win/installer.nsi').replace(/\\/g, '/'),
  ];
  const r = spawnSync(makensis, args, { cwd: REPO, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // NSIS 的 warning 大多无害（比如"未使用的变量"），但 total size / error 必须看见
  for (const line of out.split('\n')) {
    if (/error|warning|Total size|Output:/i.test(line)) info(line.trim());
  }
  if (r.status !== 0) throw new Error(`makensis 失败（exit ${r.status}）`);

  const exe = join(OUT, `qqbot-${version}-setup.exe`);
  if (!existsSync(exe)) throw new Error(`没有生成 ${exe}`);
  const size = statSync(exe).size;
  const sha = createHash('sha256').update(readFileSync(exe)).digest('hex');
  writeFileSync(join(OUT, 'SHA256SUMS.txt'), `${sha}  ${basename(exe)}\n`);

  process.stdout.write('\n');
  info(`安装包: ${relative(REPO, exe)}`);
  info(`体积  : ${(size / 1048576).toFixed(1)} MB`);
  info(`sha256: ${sha}`);
  if (size > 95 * 1024 * 1024) info('⚠ 体积偏大，检查 NapCat 裁剪是否生效');
}

// ---- main ----

async function main() {
  if (process.platform !== 'win32') throw new Error('这个构建脚本只能在 Windows 上跑（要调 makensis 与 System32\\tar）');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) throw new Error(`需要 node >= 22.13（当前 ${process.version}）`);

  process.stdout.write(`qqbot 安装包构建 ${version} (${commit})\n`);
  await fetchVendor();

  if (wantNapcat) {
    // 已经解压并裁剪过就跳过：重复解压只是为了得到同一批文件，
    // 而这个目录有七万多个文件，删了重来毫无收益。
    const dst = join(BUILD, 'napcat');
    let ready = false;
    try {
      checkNapcat(dst);
      ready = true;
    } catch (e) {
      info(`需要解压 NapCat：${e.message}`);
    }
    if (ready && !flagOn('force-napcat')) {
      step('NapCat 已就绪');
      info(`${relative(REPO, dst)}（要重新解压加 --force-napcat）`);
    } else {
      step('解压并裁剪 NapCat');
      mkdirSync(dst, { recursive: true });
      // 覆盖解压而不是先删目录：删整棵树在部分环境会被安全策略拦下，
      // 而 tar 覆盖写入的结果是一样的（裁剪在下一步重新跑）。
      extractZip(join(VENDOR, 'NapCat.Shell.zip'), dst);
      trimNapcat(dst);
      checkNapcat(dst);
    }
  }

  buildApp();
  makeInstaller(stage());
}

main().catch((e) => {
  process.stderr.write(`\n构建失败: ${e.message}\n`);
  process.exit(1);
});
