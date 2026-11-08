<#
  安装前环境检查。

  输出约定：stdout 只打 ASCII 的 KEY=VALUE 行（NSIS 的 nsExec 按系统代码页解码，
  中文很容易变乱码，所以所有给人看的文案由 installer.nsi 自己组织）；
  同时把完整结果写成 JSON 给 provision.mjs 用（它能正确读 UTF-8 路径）。
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Out = '',
  [int]$PanelPort = 5666
)

$ErrorActionPreference = 'SilentlyContinue'
$result = [ordered]@{
  admin     = $false
  installed = $false
  version   = ''
  qqExe     = ''
  taskUser  = ''
  healthz   = $false
  ports     = @{}
}

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$result.admin = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# 已安装的旧版本 → 安装器据此进入"升级模式"（隐藏目录页、保留 etc/data）
$uninst = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\qqbot'
if (Test-Path $uninst) {
  $result.installed = $true
  $result.version = (Get-ItemProperty $uninst).DisplayVersion
}

# QQ NT：NapCat 依赖它，没装的话协议端一定起不来
$qqKeys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ'
)
foreach ($k in $qqKeys) {
  if (Test-Path $k) {
    $us = (Get-ItemProperty $k).UninstallString
    if ($us) {
      $dir = Split-Path ($us.Trim('"').Split(' ')[0])
      $exe = Join-Path $dir 'QQ.exe'
      if (Test-Path $exe) { $result.qqExe = $exe; break }
    }
  }
}
if ($result.qqExe -eq '') {
  foreach ($p in @("$env:ProgramFiles\Tencent\QQNT\QQ.exe", "${env:ProgramFiles(x86)}\Tencent\QQNT\QQ.exe")) {
    if (Test-Path $p) { $result.qqExe = $p; break }
  }
}

# 交互登录用户：装 NapCat 计划任务要用它。安装器是提权的，$env:USERNAME 可能是
# 管理员账号而不是真正在用桌面的人，所以从 explorer.exe 的属主反查。
$explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1
if ($explorer) {
  $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwner
  if ($owner.User) { $result.taskUser = "$($owner.Domain)\$($owner.User)" }
}

# 端口占用：被 qqbot 自己占着是正常（覆盖安装），被别人占着必须报出来
foreach ($port in @($PanelPort, 3001, 6099)) {
  # 注意：查不到监听时 Get-NetTCPConnection 抛的是 CIM 错误而不是返回空，
  # 只靠 $ErrorActionPreference 压不住，必须显式 -ErrorAction。
  $conn = $null
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
  } catch { $conn = $null }
  if ($conn) {
    $pname = (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    $result.ports["$port"] = "$($conn.OwningProcess)|$pname"
  } else {
    $result.ports["$port"] = ''
  }
}

# 面板是否已经在跑（判断覆盖安装还是别的程序占了端口）
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PanelPort/healthz" -UseBasicParsing -TimeoutSec 3
  $result.healthz = $r.StatusCode -eq 200
} catch { $result.healthz = $false }

if ($Out -ne '') {
  $result | ConvertTo-Json -Depth 4 | Out-File -FilePath $Out -Encoding utf8
}

# ---- 给 NSIS 的 ASCII 输出 ----
"ADMIN=$(if ($result.admin) { 1 } else { 0 })"
"INSTALLED=$(if ($result.installed) { 1 } else { 0 })"
"VERSION=$($result.version)"
"QQ=$($result.qqExe)"
"TASKUSER=$(if ($result.taskUser -ne '') { 1 } else { 0 })"
"HEALTHZ=$(if ($result.healthz) { 1 } else { 0 })"
foreach ($p in @($PanelPort, 3001, 6099)) {
  $v = $result.ports["$p"]
  "PORT$($p)=$v"
}
exit 0
