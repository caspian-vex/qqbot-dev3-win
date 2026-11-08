<#
  创建服务专用的低权限本地账号，并把数据目录的权限摆正。

  为什么非要做这一步：机器人有个"电脑操作"能力，模型能在这台机器上执行命令。
  服务要是以 LocalSystem 跑，等于把整机管理员权限交给一段可能被提示词骗过去的模型。
  换成普通本地账号之后，它最多能动自己的数据目录。

  为什么不用 Get-LocalUser / New-LocalUser：那些 cmdlet 来自
  Microsoft.PowerShell.LocalAccounts 模块，只装在 64 位 PowerShell 目录下。
  安装程序是 32 位进程，nsExec 拉起的 powershell.exe 会落到 SysWOW64，
  在那儿 Get-LocalUser 直接"不是 cmdlet"，安装当场失败。
  所以这里全程只用 ADSI（WinNT provider）和 icacls —— 32/64 位都有。

  输入：%ProgramData%\qqbot\etc\service-account.json（由 provision.mjs 生成）
  输出：纯 ASCII 的一行 OK / ERR <原因>，给 installer.nsi 判断成败
  日志：%TEMP%\qqbot-account.log（逐步留痕，失败时带调用栈）
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  # precheck.ps1 的 JSON；用它拿"真正登录桌面的人"，给协议端目录授权
  [string]$Precheck = ''
)

$ErrorActionPreference = 'Stop'

# UF_DONT_EXPIRE_PASSWD / UF_ACCOUNTDISABLE / UF_PASSWD_CANT_CHANGE
$UF_DONT_EXPIRE_PASSWD = 0x10000
$UF_ACCOUNTDISABLE = 0x0002
$UF_PASSWD_CANT_CHANGE = 0x0040

# 逐步日志。装在这台机器上的东西出问题时，用户能给的就只有这个文件，
# 所以每一步都要留痕；失败时连位置一起写，不然只剩一句 "Access is denied"。
$logPath = Join-Path $env:TEMP 'qqbot-account.log'
function Log([string]$m) {
  try { Add-Content -Path $logPath -Value "$(Get-Date -Format 'HH:mm:ss') $m" -Encoding utf8 } catch { }
}

function Fail([string]$msg) {
  Log "FAILED: $msg"
  Write-Output "ERR $msg"
  exit 1
}

<#
  跑原生命令并拿到 exit code。

  为什么要这么绕：$ErrorActionPreference='Stop' 时，`& net.exe ... 2>&1` 会把
  net.exe 写到 stderr 的内容包装成 terminating error 抛出来（"没有提供有效的响应"），
  于是命令其实成功了却让脚本中止。这里临时把 EA 调回 Continue，只在调用期间生效。

  注意：net.exe 的 Y/N 交互确认（口令超过 14 位时出现）读的是控制台而不是 stdin，
  往 stdin 喂 "Y" 无效，所以不要指望在这里做重定向 —— 改成在下面直接拦长度。
#>
function Invoke-Native([string]$file, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $file @argv 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  return [pscustomobject]@{
    code = $code
    text = (($out | ForEach-Object { "$_" }) -join ' ').Trim()
  }
}

Log "=== account.ps1 开始 (root=$Root, ps=$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion), 32bit=$([Environment]::Is64BitProcess)) ==="

try {
  $acctFile = Join-Path $Root 'etc\service-account.json'
  if (-not (Test-Path $acctFile)) { Fail 'missing service-account.json' }
  $acct = Get-Content $acctFile -Raw -Encoding utf8 | ConvertFrom-Json
  $name = $acct.account
  $plain = $acct.password
  if (-not $name -or -not $plain) { Fail 'service-account.json is incomplete' }
  Log "账号文件已读取（$name）"

  # net.exe 对超过 14 位的口令会打印
  # "输入的密码超过了 14 个字符……你想继续进行操作吗? (Y/N) [Y]:"
  # 并要求按键确认；它读的是控制台不是 stdin，无人值守安装里无从应答，
  # 于是以 "没有提供有效的响应" 退非零。这里提前拦住，免得报错指向十万八千里外。
  if ($plain.Length -gt 14) {
    Fail "service account password is $($plain.Length) chars; net.exe asks for interactive confirmation above 14 and the unattended install cannot answer it. Regenerate etc\service-account.json with a password of 14 chars or fewer."
  }

  # ---- 账号 ----
  # 口令一律用 net.exe 设置。为什么不用 ADSI 的 SetPassword：那条路在建号瞬间
  # 设的口令实测不落库（后续 CreateProcessWithLogonW 直接报"用户名或密码不正确"），
  # 而 net user 走的是 NetUserAdd/NetUserSetInfo 的常规路径，各版本 Windows 都稳。
  $net = "$env:SystemRoot\System32\net.exe"
  $computer = [ADSI]"WinNT://$env:COMPUTERNAME,computer"
  $entry = $null
  try { $entry = $computer.Children.Find($name, 'user') } catch { $entry = $null }

  if ($null -eq $entry) {
    $r = Invoke-Native $net @('user', $name, $plain, '/add', '/expires:never', '/passwordchg:no')
    Log "net user /add exit=$($r.code)"
    if ($r.code -ne 0) {
      Log "  输出：$($r.text)"
      Fail "cannot create local account: $($r.text)"
    }
    Log "已创建本地账号 $name"
  } else {
    # 口令以 json 为准重设：xml 里那份是从同一个文件读的，两边必须一致，
    # 否则会出现"服务 1069 登录失败"而看不出为什么。
    $r = Invoke-Native $net @('user', $name, $plain)
    Log "net user 重设口令 exit=$($r.code)"
    if ($r.code -ne 0) {
      Log "  输出：$($r.text)"
      Fail "cannot reset account password: $($r.text)"
    }
    Log "已复用本地账号 $name 并同步口令"
  }
  Log "口令长度=$($plain.Length)（不记录内容）"

  # 口令永不过期（默认 42 天，过期后服务就登不上了）、启用账号、用户不可改口令。
  try { $entry = $computer.Children.Find($name, 'user') } catch { }
  if ($entry) {
    $flags = [int]$entry.Get('UserFlags')
    $flags = $flags -bor $UF_DONT_EXPIRE_PASSWD -bor $UF_PASSWD_CANT_CHANGE
    $flags = $flags -band (-bnot $UF_ACCOUNTDISABLE)
    $entry.Put('UserFlags', $flags)
    $entry.SetInfo()
    Log ("UserFlags 已设置（0x{0:X}）" -f $flags)
  } else {
    Log '警告：ADSI 绑定账号失败，跳过 UserFlags（口令过期策略未设置）'
  }

  # 加进 Users 组：net user /add 建号会自动加，ADSI 建号不会。
  # 少了这一步，服务账号执行 System32 下的程序会因缺少 Users:(RX) 被拒。
  $usersGroup = $null
  foreach ($p in @("WinNT://$env:COMPUTERNAME/Users,group", "WinNT://$env:COMPUTERNAME/S-1-5-32-545,group")) {
    try { $usersGroup = [ADSI]$p; break } catch { }
  }
  if ($usersGroup) {
    try { $usersGroup.Add("WinNT://$env:COMPUTERNAME/$name"); Log '已加入 Users 组' }
    catch { Log 'Users 组加入跳过（可能已在组内）' }
  } else {
    Log 'Users 组定位失败'
  }

  # 绝不能在任何管理员组里（有人手工加过也要拉出来）
  $adminsGroup = $null
  foreach ($p in @("WinNT://$env:COMPUTERNAME/Administrators,group", "WinNT://$env:COMPUTERNAME/S-1-5-32-544,group")) {
    try { $adminsGroup = [ADSI]$p; break } catch { }
  }
  if ($adminsGroup) {
    try { $adminsGroup.Remove("WinNT://$env:COMPUTERNAME/$name"); Log '已从 Administrators 移除' }
    catch { Log '不在 Administrators 组（正常）' }
  } else {
    Log 'Administrators 组定位失败'
  }

  # ---- 目录权限 ----
  # 断掉继承再逐目录授予：默认的 Users:(RX) 会让服务账号能读 etc 下的密钥文件，
  # 也会让任何本地用户能读聊天数据库。
  $adminSid = 'S-1-5-32-544'
  $systemSid = 'S-1-5-18'
  & icacls.exe $Root /inheritance:r /grant "*${adminSid}:(OI)(CI)F" "*${systemSid}:(OI)(CI)F" | Out-Null
  Log "icacls 根目录 exit=$LASTEXITCODE"

  & icacls.exe (Join-Path $Root 'etc') /grant "${name}:(OI)(CI)R" | Out-Null
  Log "icacls etc exit=$LASTEXITCODE"
  foreach ($d in @('data', 'logs', 'backup')) {
    $p = Join-Path $Root $d
    if (Test-Path $p) {
      & icacls.exe $p /grant "${name}:(OI)(CI)M" | Out-Null
      Log "icacls $d exit=$LASTEXITCODE"
    }
  }

  # 协议端目录：给登录桌面的人改，同时**明确拒绝**服务账号。
  # 理由：模型能写文件，写进 napcat\config 就能改协议端配置（比如把 OneBot
  # 控制面开到公网），这条拒绝把那条路堵死。
  $napcat = Join-Path $Root 'napcat'
  if (Test-Path $napcat) {
    $napcatUser = ''
    if ($Precheck -ne '' -and (Test-Path $Precheck)) {
      try {
        $pc = Get-Content $Precheck -Raw -Encoding utf8 | ConvertFrom-Json
        $napcatUser = $pc.taskUser
      } catch { }
    }
    if ($napcatUser -ne '') {
      & icacls.exe $napcat /grant "${napcatUser}:(OI)(CI)M" | Out-Null
      # NapCat 还要往上级的 logs 目录写自己的运行日志
      $logs = Join-Path $Root 'logs'
      if (Test-Path $logs) { & icacls.exe $logs /grant "${napcatUser}:(OI)(CI)M" | Out-Null }
    }
    & icacls.exe $napcat /deny "${name}:(OI)(CI)F" | Out-Null
    Log "napcat 授权完成（交互用户=$napcatUser）"
  }

  # ---- "作为服务登录" ----
  # WinSW 的 allowservicelogon 走 SCM API 一般会自动授予；这里再显式写一遍，
  # 是为了避开某些被加固过的机器上 sc start 报 1069 的那个坑。
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $name)).Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
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
    Set-Content -Path $tmp -Value $lines -Encoding unicode
    & secedit.exe /configure /db $db /cfg $tmp /areas USER_RIGHTS | Out-Null
    Remove-Item $tmp, $db -ErrorAction SilentlyContinue
    Log "SeServiceLogonRight 已授予（$sid）"
  } catch {
    # 拿不到也不致命：SCM 通常自己会授
    Log "SeServiceLogonRight 跳过：$($_.Exception.Message)"
  }

  # ---- 自检 ----
  # 用服务账号真的写一次文件。icacls 配错时服务会"一闪就停"，
  # 日志都来不及写，那种现场比安装时报错难查一百倍。
  #
  # 注意这里**不中止安装**：这个探针依赖 CreateProcessWithLogonW，在个别加固过的
  # 机器上会因为二次登录被策略挡住而误报，而真正的判据是紧接着 sc start 能不能起来。
  # 所以失败只记警告，把结论交给服务和 wait-credential。
  $probe = Join-Path $Root 'data\.write-probe'
  Log "开始写入自检（$probe）"
  $probeOk = $false
  try {
    $secure = ConvertTo-SecureString $plain -AsPlainText -Force
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
    Log "探针子进程 exit=$($p.ExitCode)"
    $probeOk = Test-Path $probe
    if ($probeOk) {
      Remove-Item $probe -Force -ErrorAction SilentlyContinue
      Log "写入自检通过"
    } else {
      Log '写入自检未通过：服务账号没有写出文件（ACL 或口令问题）'
    }
  } catch {
    $code = ''
    if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception]) {
      $code = " (native=$($_.Exception.InnerException.NativeErrorCode))"
    }
    # 1326（用户名或密码不正确）在这类机器上是 CreateProcessWithLogonW 的误报：
    # 同一组口令 SCM 能登进去，二次登录却被挡。不影响安装，服务能不能起来才是判据。
    Log "写入自检未通过$code：$($_.Exception.Message)（不影响安装）"
  }

  Log "=== account.ps1 结束 ==="
  if ($probeOk) { Write-Output "OK $name" } else { Write-Output "OK $name (write-probe-skipped)" }
  exit 0
} catch {
  Log "未捕获异常：$($_.Exception.Message)"
  Log "位置：$($_.InvocationInfo.PositionMessage)"
  Log "调用栈：$($_.ScriptStackTrace)"
  Fail $_.Exception.Message
}
