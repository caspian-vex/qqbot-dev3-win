<#
  安装前环境检查。

  两种输出：
    1. stdout 只打 ASCII 的 KEY=VALUE（NSIS 的 nsExec 按系统代码页解码，中文很容易乱码，
       所以给人看的文案一律走弹窗，不走 stdout）
    2. -Out 指定的 JSON 给 provision.mjs 用（它能正确读 UTF-8 路径与中文用户名）

  退出码：0 通过（可能有警告），1 有致命问题（安装器会中止）。
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Out = '',
  [int]$PanelPort = 5666,
  [int]$Interaction = 0
)

$ErrorActionPreference = 'SilentlyContinue'
$fatal = New-Object System.Collections.ArrayList
$warn = New-Object System.Collections.ArrayList

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
if (-not $result.admin) { [void]$fatal.Add('安装需要管理员权限。请右键安装程序，选择「以管理员身份运行」。') }

# 已安装旧版本 → 安装器据此进入升级模式（保留 etc/data）
$uninst = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\qqbot'
if (Test-Path $uninst) {
  $result.installed = $true
  $result.version = (Get-ItemProperty $uninst).DisplayVersion
}

# QQ NT：NapCat 依赖它。没装不影响本体，但协议端起不来，必须提前说清楚。
#
# 只认 Uninstall\QQ 那个键是不够的：实测有的机器（QQ 装到 D:\qq 这种自定义目录、
# 或者用某些"绿色版"装法）根本没有这个卸载项，于是明明装了 QQ 却被判成没装、
# 协议端也起不来。这里按"从最确定到最不确定"的顺序退：卸载项 → App Paths →
# 常见目录 → 正在运行的 QQ 进程 → 开始菜单快捷方式。
function Resolve-TencentQq {
  $candidates = New-Object System.Collections.Generic.List[string]

  # 1) 卸载项：UninstallString 指向 uninst.exe，同目录就是 QQ.exe
  foreach ($k in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ',
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ'
    )) {
    if (-not (Test-Path $k)) { continue }
    $v = Get-ItemProperty $k -ErrorAction SilentlyContinue
    if ($v.UninstallString) {
      $candidates.Add((Join-Path (Split-Path ($v.UninstallString.Trim('"').Split(' ')[0])) 'QQ.exe'))
    }
    if ($v.InstallLocation) { $candidates.Add((Join-Path $v.InstallLocation 'QQ.exe')) }
    if ($v.DisplayIcon) { $candidates.Add(($v.DisplayIcon.Trim('"') -replace ',\s*\d+$', '')) }
  }

  # 2) App Paths：安装器喜欢写这里，和卸载项不同步的概率低
  foreach ($k in @(
      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe',
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe'
    )) {
    if (Test-Path $k) {
      $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'
      if ($v) { $candidates.Add($v.Trim('"')) }
    }
  }

  # 3) 常见安装目录
  foreach ($p in @(
      "$env:ProgramFiles\Tencent\QQNT\QQ.exe",
      "${env:ProgramFiles(x86)}\Tencent\QQNT\QQ.exe",
      "$env:LOCALAPPDATA\Programs\Tencent\QQNT\QQ.exe"
    )) { $candidates.Add($p) }

  # 4) 正在运行的 QQ：自定义安装路径基本只能从这里拿到
  foreach ($proc in (Get-Process -Name QQ -ErrorAction SilentlyContinue)) {
    try { if ($proc.Path) { $candidates.Add($proc.Path) } } catch { }
  }

  # 5) 开始菜单快捷方式（用户级 + 全局），解出目标
  $sh = $null
  try { $sh = New-Object -ComObject WScript.Shell } catch { }
  if ($sh) {
    $menus = @(
      "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
      "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
    )
    foreach ($m in $menus) {
      if (-not (Test-Path $m)) { continue }
      foreach ($lnk in (Get-ChildItem $m -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
        if ($lnk.BaseName -notmatch 'QQ') { continue }
        try {
          $target = $sh.CreateShortcut($lnk.FullName).TargetPath
          if ($target) { $candidates.Add($target) }
        } catch { }
      }
    }
  }

  foreach ($c in $candidates) {
    if ($c -and ($c -match '\.exe$') -and (Test-Path $c)) {
      # 排除卸载程序、更新器之类
      if ((Split-Path $c -Leaf) -ieq 'QQ.exe') { return (Resolve-Path $c).Path }
    }
  }
  return ''
}

$result.qqExe = Resolve-TencentQq
if ($result.qqExe -eq '') {
  [void]$warn.Add("没有检测到 QQ NT。NapCat 协议端必须依赖它，装完协议端起不来。`n可以先从 im.qq.com 安装 QQ，然后重新运行安装包。`n如果 QQ 装在自定义目录，装完把 QQ.exe 的完整路径写进 ProgramData\qqbot\napcat\qq-path.txt 也能用。")
}

# 交互登录用户：装协议端计划任务要用它。安装器是提权的，$env:USERNAME 可能是
# 管理员账号而不是真正在用桌面的人，所以从 explorer.exe 的属主反查。
$explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1
if ($explorer) {
  $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwner
  if ($owner.User) { $result.taskUser = "$($owner.Domain)\$($owner.User)" }
}
if ($result.taskUser -eq '') {
  [void]$warn.Add("没有检测到已登录的桌面用户。协议端的「登录后自启」任务无法注册（可以稍后重新运行安装包补上）。")
}

# 端口占用
foreach ($port in @($PanelPort, 3001, 6099)) {
  # 查不到监听时 Get-NetTCPConnection 抛的是 CIM 错误而不是返回空，
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

if ($result.ports["$PanelPort"] -ne '') {
  [void]$fatal.Add("端口 $PanelPort 已被占用（$($result.ports["$PanelPort"])）。`n它是面板端口，被占用时服务会启动失败。请先关掉占用它的程序，或装完后改 etc\qqbot.toml 里的 panel.listen。")
}
foreach ($port in @(3001, 6099)) {
  if ($result.ports["$port"] -ne '') {
    [void]$warn.Add("端口 $port 已被占用（$($result.ports["$port"])）。`n协议端需要这两个端口；被别的程序占着时 NapCat 可能起不来或换端口，面板会连不上。")
  }
}

if ($Out -ne '') {
  $result | ConvertTo-Json -Depth 4 | Out-File -FilePath $Out -Encoding utf8
}

# ---- 弹窗（给人看的中文都在这里） ----
if ($Interaction -eq 1 -and ($fatal.Count -gt 0 -or $warn.Count -gt 0)) {
  Add-Type -AssemblyName System.Windows.Forms
  if ($fatal.Count -gt 0) {
    $msg = "安装无法继续：`n`n" + ($fatal -join "`n`n")
    [void][System.Windows.Forms.MessageBox]::Show($msg, 'qqbot 安装检查', 'OK', 'Error')
  }
  if ($warn.Count -gt 0) {
    $msg = "安装可以继续，但请注意：`n`n" + ($warn -join "`n`n")
    [void][System.Windows.Forms.MessageBox]::Show($msg, 'qqbot 安装检查', 'OK', 'Warning')
  }
}

# ---- 给 NSIS 的 ASCII 输出 ----
"ADMIN=$(if ($result.admin) { 1 } else { 0 })"
"INSTALLED=$(if ($result.installed) { 1 } else { 0 })"
"VERSION=$($result.version)"
"QQ$(if ($result.qqExe -ne '') { '=FOUND' } else { '=MISSING' })"
"TASKUSER=$(if ($result.taskUser -ne '') { 1 } else { 0 })"
foreach ($p in @($PanelPort, 3001, 6099)) {
  "PORT$($p)=$(if ($result.ports["$p"] -ne '') { 1 } else { 0 })"
}

if ($fatal.Count -gt 0) { exit 1 } else { exit 0 }
