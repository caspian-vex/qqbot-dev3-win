<#
  创建服务专用的低权限本地账号，并把数据目录的权限摆正。

  为什么非要做这一步：机器人有个"电脑操作"能力，模型能在这台机器上执行命令。
  服务要是以 LocalSystem 跑，等于把整机管理员权限交给一段可能被提示词骗过去的模型。
  换成普通本地账号之后，它最多能动自己的数据目录。

  输入：%ProgramData%\qqbot\etc\service-account.json（由 provision.mjs 生成）
  输出：纯 ASCII 的一行 OK / ERR <原因>，给 installer.nsi 判断成败
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$NapcatUser = ''
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  Write-Output "ERR $msg"
  exit 1
}

try {
  $acctFile = Join-Path $Root 'etc\service-account.json'
  if (-not (Test-Path $acctFile)) { Fail 'missing service-account.json' }
  $acct = Get-Content $acctFile -Raw -Encoding utf8 | ConvertFrom-Json
  $name = $acct.account
  $plain = $acct.password
  if (-not $name -or -not $plain) { Fail 'service-account.json is incomplete' }

  # ---- 账号 ----
  $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  $secure = ConvertTo-SecureString $plain -AsPlainText -Force
  if ($null -eq $user) {
    New-LocalUser -Name $name -Password $secure -FullName 'qqbot service' `
      -Description 'qqbot 服务专用账号（低权限）' -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  } else {
    # 口令以 json 为准重设：xml 里那份是从同一个文件读的，两边必须一致，
    # 否则会出现"服务 1069 登录失败"而看不出为什么。
    Set-LocalUser -Name $name -Password $secure
    Set-LocalUser -Name $name -PasswordNeverExpires $true
    Enable-LocalUser -Name $name -ErrorAction SilentlyContinue
  }

  # 绝不能在任何管理员组里（有人手工加过也要拉出来）
  try {
    $members = Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop
    if ($members.Name -match "\\$([regex]::Escape($name))$") {
      Remove-LocalGroupMember -Group 'Administrators' -Member $name
    }
  } catch { }

  # ---- 目录权限 ----
  # 断掉继承再逐目录授予：默认的 Users:(RX) 会让服务账号能读 etc 下的密钥文件，
  # 也会让任何本地用户能读聊天数据库。
  $adminSid = 'S-1-5-32-544'
  $systemSid = 'S-1-5-18'
  & icacls.exe $Root /inheritance:r /grant "*${adminSid}:(OI)(CI)F" "*${systemSid}:(OI)(CI)F" | Out-Null

  & icacls.exe (Join-Path $Root 'etc') /grant "${name}:(OI)(CI)R" | Out-Null
  foreach ($d in @('data', 'logs', 'backup')) {
    $p = Join-Path $Root $d
    if (Test-Path $p) { & icacls.exe $p /grant "${name}:(OI)(CI)M" | Out-Null }
  }

  # 协议端目录：给登录桌面的人改，同时**明确拒绝**服务账号。
  # 理由：模型能写文件，写进 napcat\config 就能改协议端配置（比如把 OneBot
  # 控制面开到公网），这条拒绝把那条路堵死。
  $napcat = Join-Path $Root 'napcat'
  if (Test-Path $napcat) {
    if ($NapcatUser -ne '') { & icacls.exe $napcat /grant "${NapcatUser}:(OI)(CI)M" | Out-Null }
    & icacls.exe $napcat /deny "${name}:(OI)(CI)F" | Out-Null
  }

  # ---- "作为服务登录" ----
  # WinSW 的 allowservicelogon 走 SCM API 一般会自动授予；这里再显式写一遍，
  # 是为了避开某些被加固过的机器上 sc start 报 1069 的那个坑。
  try {
    $sid = (Get-LocalUser -Name $name).SID.Value
    $tmp = Join-Path $env:TEMP "qqbot-secedit-$PID.inf"
    $db = Join-Path $env:TEMP "qqbot-secedit-$PID.sdb"
    & secedit.exe /export /cfg $tmp /areas USER_RIGHTS | Out-Null
    $lines = Get-Content $tmp
    $prefix = 'SeServiceLogonRight'
    $cur = $lines | Where-Object { $_ -like "$prefix*" }
    if ($cur) {
      if ($cur -notmatch [regex]::Escape($sid)) {
        $lines = $lines -replace "^$prefix.*", "$prefix = $($cur.Split('=', 2)[1].Trim() ),$sid"
      }
    } else {
      $lines += "$prefix = *$sid"
    }
    $lines += '[Version]'
    $lines += 'signature="$CHICAGO$"'
    Set-Content -Path $tmp -Value $lines -Encoding unicode
    & secedit.exe /configure /db $db /cfg $tmp /areas USER_RIGHTS | Out-Null
    Remove-Item $tmp, $db -ErrorAction SilentlyContinue
  } catch {
    # 拿不到也不致命：SCM 通常自己会授
  }

  # ---- 自检 ----
  # 用服务账号真的写一次文件。icacls 配错时服务会"一闪就停"，
  # 日志都来不及写，那种现场比安装时报错难查一百倍。
  $probe = Join-Path $Root 'data\.write-probe'
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
    $psi.Arguments = "/c echo ok> `"$probe`""
    $psi.UserName = "$env:COMPUTERNAME\$name"
    $psi.Password = $secure
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $env:SystemRoot
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.WaitForExit(15000) | Out-Null
    if (-not (Test-Path $probe)) { Fail 'service account cannot write data dir (ACL?)' }
    Remove-Item $probe -Force -ErrorAction SilentlyContinue
  } catch {
    Fail "write probe failed: $($_.Exception.Message)"
  }

  Write-Output "OK $name"
  exit 0
} catch {
  Fail $_.Exception.Message
}
