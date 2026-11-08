// 校验（必要时纠正）服务跑在哪个账号下。
//
// 为什么需要这一步：WinSW 的 <serviceaccount> 子元素在不同大版本之间改过名字
// （2.x 是 domain/user/password，3.x 是 username/password）。元素名写错时
// WinSW 不报错、不警告，直接把服务装成 LocalSystem —— 而本项目最重要的安全
// 前提恰恰是"服务不能是 LocalSystem"，因为它带着一个能执行命令的模型。
// 这里用 sc.exe 事后核对一遍，不对就改回来。
//
// 用法：
//   node set-service-account.mjs --root <dataRoot> [--service qqbot]
//
// 退出码：0 已是目标账号 / 已纠正；1 纠正失败（安装器据此中止）
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const root = resolve(arg('root', join(process.env.ProgramData ?? 'C:\\ProgramData', 'qqbot')));
const service = arg('service', 'qqbot');

function out(line) {
  process.stdout.write(`${line}\n`);
}

function sc(args) {
  try {
    return execFileSync('sc.exe', args, { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    return e.stdout ?? '';
  }
}

const acctPath = join(root, 'etc', 'service-account.json');
if (!existsSync(acctPath)) {
  out('ERR 缺少 etc/service-account.json，无法核对服务账号');
  process.exit(1);
}
const acct = JSON.parse(readFileSync(acctPath, 'utf8'));
const want = `.\\${acct.account}`;

const qc = sc(['qc', service]);
if (!qc || /FAILED|1060/.test(qc)) {
  out(`ERR 服务 ${service} 不存在`);
  process.exit(1);
}

const m = /SERVICE_START_NAME\s*:\s*(\S+)/i.exec(qc);
const current = m ? m[1] : '';
out(`当前账号: ${current || '(未知)'}`);

const normalize = (s) => s.replace(/^\.\\/, '').toLowerCase();
if (normalize(current) === acct.account.toLowerCase()) {
  out(`OK ${current} 已是目标账号`);
  process.exit(0);
}

out(`需要纠正: ${current} -> ${want}`);
// obj= 后面必须有一个空格，这是 sc.exe 的参数解析规则，不是笔误。
const res = sc(['config', service, 'obj=', want, 'password=', acct.password]);
const after = sc(['qc', service]);
const m2 = /SERVICE_START_NAME\s*:\s*(\S+)/i.exec(after);
const now = m2 ? m2[1] : '';

if (normalize(now) === acct.account.toLowerCase()) {
  out(`OK 已纠正为 ${now}`);
  process.exit(0);
}

out(`ERR sc config 未能纠正（${res.trim().split('\n').pop()}；现在仍是 ${now || '未知'}）`);
process.exit(1);
