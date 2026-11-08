; qqbot 的 Windows 安装包。
;
; 设计要点（都是踩过的坑，不要随手改）：
;  1. 程序装进 Program Files（只读），数据放 ProgramData（可写）。没有任何主体需要
;     写程序目录，所以"服务账号写不了自己的程序"这类权限问题从根上不存在。
;  2. 一切配置生成都丢给 tools\provision.mjs（node）。NSIS 没有安全随机数、
;     没有 JSON 处理、写 UTF-16 要自己拼 BOM，三样都属于"错了要到运行时才发现"。
;  3. 密码不在这里生成：服务首次启动时生成、打到 stdout、WinSW 落到日志，
;     再由 tools\wait-credential.mjs 捞回来。这样升级时自然就是"沿用原密码"。
;  4. NapCat 装完不自动启动：拉 NapCat 会重启本机 QQ，把用户当前登录的号顶掉。
;  5. 快捷方式与"开机自启"相关的收尾动作放在 .onInstSuccess：
;     Section 只有在被勾选时才会执行，而"取消自启"恰恰是没勾选的那个分支，
;     写在 Section 里就永远执行不到。
;  6. 预检脚本走 $PLUGINSDIR 而不是 $INSTDIR：它必须在"往 Program Files 写任何
;     东西之前"跑，否则检查不通过时已经留下半套文件了。
;  7. 注册表统一 SetRegView 64：precheck.ps1 用 64 位 PowerShell 读 Uninstall 键，
;     NSIS 默认走 32 位重定向，两边不一致会导致"明明装了却认不出是升级"。
;
; 编译：
;   makensis /DAPP_VERSION=0.10.0 /DSTAGE=<stage> /DOUTDIR=<out> installer.nsi
; （packaging\win\build.mjs 会自动传这些参数，一般不用手敲）

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ManifestDPIAware true
XPStyle on
RequestExecutionLevel admin
BrandingText "qqbot"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"
!include "WinVer.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0-dev"
!endif
!ifndef STAGE
  !error "缺少 /DSTAGE"
!endif
!ifndef OUTDIR
  !define OUTDIR "."
!endif
!ifndef HAVE_NAPCAT
  !define HAVE_NAPCAT 1
!endif

!define APP_NAME   "qqbot"
!define SVC_NAME   "qqbot"
!define SVC_EXE    "qqbot-svc.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\qqbot"
!define APP_KEY    "Software\qqbot"

Name "qqbot ${APP_VERSION}"
OutFile "${OUTDIR}/qqbot-${APP_VERSION}-setup.exe"
InstallDir "$PROGRAMFILES64\qqbot"
InstallDirRegKey HKLM "${APP_KEY}" "InstallDir"
Icon "${STAGE}/app/assets/qqbot.ico"
UninstallIcon "${STAGE}/app/assets/qqbot.ico"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "qqbot"
VIAddVersionKey /LANG=2052 "FileDescription" "qqbot 安装程序（QQ 机器人 + 网页控制面板）"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT"

Var DataRoot
Var CredUser
Var CredPass
Var CredState
Var IsUpgrade
Var InstalledVer
Var Interaction
Var PrecheckJson
Var PsExe
Var hEdit
Var hBtn
Var hLbl

; ---------------- 安装日志 ----------------
;
; 静默安装（/S）时 DetailPrint 没有任何去处，装失败了用户手上什么线索都没有。
; 这里把每一步写进 %TEMP%\qqbot-install.log（UTF-16LE，记事本直接能看）。
; 用 UTF-16LE 而不是 ANSI：脚本里有中文，ANSI 会随系统区域设置变乱码。
!macro LogMsg msg
  FileOpen $9 "$TEMP\qqbot-install.log" a
  FileWriteUTF16LE $9 "${msg}$\r$\n"
  FileClose $9
!macroend

; ---------------- 页面 ----------------

!define MUI_ABORTWARNING
!define MUI_ICON "${STAGE}/app/assets/qqbot.ico"
!define MUI_UNICON "${STAGE}/app/assets/qqbot.ico"

!define MUI_WELCOMEPAGE_TITLE "安装 qqbot ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "这个向导会把 qqbot 装成 Windows 服务：开机自动运行，不需要有人登录桌面；$\r$\n控制面板是一个本地网页 http://127.0.0.1:5666。$\r$\n$\r$\n装完还需要两步：在面板里扫码登录 QQ、在「全局设置」里填模型接口与 API Key。"
!insertmacro MUI_PAGE_WELCOME

!define MUI_LICENSEPAGE_TEXT_TOP "下面这段不是法律许可证，而是这套东西会对你机器做什么的说明。"
!insertmacro MUI_PAGE_LICENSE "${STAGE}\app\LICENSE.txt"

!define MUI_COMPONENTSPAGE_SMALLDESC
!insertmacro MUI_PAGE_COMPONENTS

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

Page custom CredPageShow CredPageLeave

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------------- 初始化 ----------------

Function .onInit
  SetRegView 64

  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "需要 Windows 10 或更高版本。"
    Abort
  ${EndIf}

  ; ProgramData 路径不要硬编码 C:\ProgramData：有的机器改过系统盘或重定向过。
  ; 这里取到的值必须和 node 里 process.env.ProgramData 一致，
  ; 否则安装器与服务会看到两套目录，配置和数据库"凭空消失"。
  ReadEnvStr $0 "ProgramData"
  ${If} $0 == ""
    StrCpy $0 "C:\ProgramData"
  ${EndIf}
  StrCpy $DataRoot "$0\qqbot"

  ; 静默安装（/S）时不能弹窗，否则会卡在无人应答的对话框上。
  StrCpy $Interaction "1"
  ${If} ${Silent}
    StrCpy $Interaction "0"
  ${EndIf}

  ; 安装程序本身是 32 位进程，nsExec 直接拉 "powershell.exe" 会落到 SysWOW64，
  ; 而 Microsoft.PowerShell.LocalAccounts、NetTCPIP 这些模块只装在 64 位目录下，
  ; 在那儿 Get-LocalUser / Get-NetTCPConnection 会直接报"不是 cmdlet"。
  ; Sysnative 是 WOW64 的魔法别名，指回真正的 System32。
  StrCpy $PsExe '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"'
  ${IfNot} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $PsExe 'powershell.exe'
  ${EndIf}

  ; 预检脚本先解到临时目录，这样"检查"能发生在写入 Program Files 之前。
  InitPluginsDir
  File /oname=$PLUGINSDIR\precheck.ps1 "${STAGE}\app\tools\precheck.ps1"
  File /oname=$PLUGINSDIR\account.ps1 "${STAGE}\app\tools\account.ps1"
  StrCpy $PrecheckJson "$PLUGINSDIR\precheck.json"

  ; 初始化日志（写 UTF-16LE 的 BOM，否则记事本会当 ANSI 打开）
  FileOpen $9 "$TEMP\qqbot-install.log" w
  FileWriteByte $9 255
  FileWriteByte $9 254
  FileWriteUTF16LE $9 "qqbot ${APP_VERSION} 安装日志$\r$\n目标目录：$INSTDIR$\r$\n数据目录：$DataRoot$\r$\n$\r$\n"
  FileClose $9

  ReadRegStr $InstalledVer HKLM "${UNINST_KEY}" "DisplayVersion"
  ${If} $InstalledVer != ""
    StrCpy $IsUpgrade "1"
    ReadRegStr $0 HKLM "${APP_KEY}" "InstallDir"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
    ; 升级必须先停服务：node.exe 与 dist\server.js 正被占用，直接覆盖会写失败
    ${If} ${FileExists} "$INSTDIR\service\${SVC_EXE}"
      DetailPrint "检测到已安装 $InstalledVer，先停止旧服务…"
      nsExec::ExecToLog '"$INSTDIR\service\${SVC_EXE}" stop'
      Sleep 2000
      nsExec::ExecToLog '"$INSTDIR\service\${SVC_EXE}" uninstall'
      Sleep 800
    ${EndIf}
  ${Else}
    StrCpy $IsUpgrade "0"
  ${EndIf}
FunctionEnd

; ---------------- 组件 ----------------

Section "qqbot 本体（必需）" SEC_CORE
  SectionIn RO

  ; 环境预检放最前面：QQ 没装、端口被占这些问题应该在装之前说清楚，
  ; 而不是装完发现机器人连不上再回来查。
  Call RunPrecheck

  SetOutPath "$INSTDIR"
  File /r "${STAGE}\app\*.*"

  ; 必须显式写出来：NSIS 不会因为存在 Uninstall 段就自动生成卸载程序，
  ; 少了这一条装完就卸不掉（makensis 只会给一个 warning 6020，很容易漏看）。
  WriteUninstaller "$INSTDIR\uninstall.exe"

  Call Provision
  Call CreateAccount
  Call InstallService
  Call FetchCredential
  Call WriteRegEntries
SectionEnd

!if ${HAVE_NAPCAT} == 1
Section "NapCat 协议端（需要已安装 QQ NT）" SEC_NAPCAT
  SetOutPath "$DataRoot\napcat"
  File /r "${STAGE}\napcat\*.*"

  DetailPrint "配置协议端…"
  !insertmacro LogMsg "[napcat] 写入协议端文件并生成配置"
  nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\tools\provision.mjs" --app "$INSTDIR" --root "$DataRoot" --precheck "$PrecheckJson" --napcat'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  exit=$0 / $1"
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION "协议端配置生成失败（本体不受影响）。$\r$\n请查看安装详情页的日志，或重装时只勾选本体。"
  ${Else}
    ; 目录权限要在文件落盘之后再摆一遍：account.ps1 里对 napcat 目录有"明确拒绝
    ; 服务账号"的规则，而那个目录是本 Section 才创建的。
    DetailPrint "校正协议端目录权限…"
    nsExec::ExecToLog '$PsExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\tools\account.ps1" -Root "$DataRoot" -Precheck "$PrecheckJson"'

    ; 登录后自启的计划任务：管理员权限但不弹 UAC
    ${If} ${FileExists} "$DataRoot\napcat\qqbot-napcat.task.xml"
      nsExec::ExecToStack 'schtasks.exe /Create /TN "qqbot-napcat" /XML "$DataRoot\napcat\qqbot-napcat.task.xml" /F'
      Pop $0
      Pop $1
      ${If} $0 == "0"
        DetailPrint "已注册登录自启任务：qqbot-napcat"
      ${Else}
        DetailPrint "计划任务注册失败（$0）：可稍后重新运行安装包补上"
      ${EndIf}
    ${EndIf}
  ${EndIf}
SectionEnd
!endif

Section "开机自启" SEC_AUTOSTART
  ; 实际动作在 .onInstSuccess 里做：只有"取消勾选"时才需要改配置，
  ; 而取消勾选的 Section 根本不会执行到这里。
  DetailPrint "已选择开机自启：服务随系统启动，协议端在你登录后启动"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "程序本体：控制面板、机器人逻辑、Windows 服务。必装。"
!if ${HAVE_NAPCAT} == 1
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_NAPCAT} "QQ 协议端。依赖机器上已安装的 QQ NT；装完不会自动启动，避免把你正在用的 QQ 顶下线。"
!endif
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_AUTOSTART} "服务开机自启、协议端登录后自启。取消勾选则两者都改为手动启动。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------- 各步骤 ----------------

Function RunPrecheck
  DetailPrint "检查运行环境…"
  !insertmacro LogMsg "[1/5] 运行环境预检"
  nsExec::ExecToStack '$PsExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\precheck.ps1" -Root "$DataRoot" -Out "$PrecheckJson" -Interaction $Interaction'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  exit=$0"
  ${If} $0 != "0"
    !insertmacro LogMsg "  预检未通过，安装中止"
    ; precheck 已经用中文弹窗说明原因了，这里不再重复
    Abort "环境检查未通过"
  ${EndIf}
  !insertmacro LogMsg "  预检通过"
FunctionEnd

Function Provision
  DetailPrint "生成配置…"
  !insertmacro LogMsg "[2/5] 生成配置（provision.mjs）"
  nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\tools\provision.mjs" --app "$INSTDIR" --root "$DataRoot" --precheck "$PrecheckJson"'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  exit=$0"
  !insertmacro LogMsg "  输出：$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "生成配置失败。$\r$\n$\r$\n请确认 $DataRoot 可写，并把这条日志一起反馈：$\r$\n$TEMP\qqbot-install.log"
    Abort "配置生成失败"
  ${EndIf}
FunctionEnd

Function CreateAccount
  DetailPrint "配置服务账号与目录权限…"
  !insertmacro LogMsg "[3/5] 服务账号与目录权限（account.ps1）"
  nsExec::ExecToStack '$PsExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\tools\account.ps1" -Root "$DataRoot" -Precheck "$PrecheckJson"'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  exit=$0"
  !insertmacro LogMsg "  输出：$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "服务账号配置失败：$\r$\n$1$\r$\n$\r$\n详细步骤见 $TEMP\qqbot-account.log$\r$\n服务将无法启动。修好权限后重新运行安装包即可，已装的文件会被覆盖，数据不受影响。"
    Abort "账号配置失败"
  ${EndIf}
FunctionEnd

Function InstallService
  DetailPrint "注册 Windows 服务…"
  !insertmacro LogMsg "[4/5] 注册并启动服务"
  nsExec::ExecToStack '"$INSTDIR\service\${SVC_EXE}" install'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  install exit=$0 / $1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "服务注册失败：$\r$\n$1$\r$\n$\r$\n日志：$TEMP\qqbot-install.log"
    Abort "服务注册失败"
  ${EndIf}

  ; WinSW 的 serviceaccount 元素名写错时不会报错，只会把服务装成 LocalSystem。
  ; 这里核对一遍，不对就改回来——"服务不是管理员"是这套东西的安全前提。
  DetailPrint "核对服务运行账号…"
  nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\tools\set-service-account.mjs" --root "$DataRoot"'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  账号核对 exit=$0 / $1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP "服务没有以低权限账号运行，安装中止。$\r$\n$1$\r$\n$\r$\n日志：$TEMP\qqbot-install.log"
    Abort "服务账号校验失败"
  ${EndIf}

  DetailPrint "启动服务…"
  nsExec::ExecToStack '"$INSTDIR\service\${SVC_EXE}" start'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  start exit=$0 / $1"
  ${If} $0 != "0"
    ; 不 Abort：文件已经装好了，服务起不来多半是账号或端口问题，
    ; 让 FetchCredential 去超时并给出日志尾部，比直接失败有用得多。
    DetailPrint "服务启动返回 $0：$1"
  ${EndIf}
FunctionEnd

Function FetchCredential
  DetailPrint "等待面板就绪并取回初始凭据…"
  !insertmacro LogMsg "[5/5] 等待面板就绪"
  nsExec::ExecToStack '"$INSTDIR\node\node.exe" "$INSTDIR\tools\wait-credential.mjs" --root "$DataRoot" --timeout 90'
  Pop $0
  Pop $1
  !insertmacro LogMsg "  exit=$0 / $1"
  StrCpy $CredState "$1"
  StrCpy $CredUser ""
  StrCpy $CredPass ""

  ; 输出约定见 wait-credential.mjs：OK user|pass / EXISTING / TIMEOUT ...
  ${If} $1 == "EXISTING"
    StrCpy $CredState "EXISTING"
  ${Else}
    StrCpy $2 $1 2
    ${If} $2 == "OK"
      StrCpy $3 $1 "" 3      ; 去掉 "OK " 前缀，剩下 user|pass
      StrCpy $6 0
      cred_split:
        StrCpy $7 $3 1 $6
        ${If} $7 == ""
          StrCpy $CredPass $3
          Goto cred_split_done
        ${EndIf}
        ${If} $7 == "|"
          StrCpy $CredUser $3 $6
          IntOp $8 $6 + 1
          StrCpy $CredPass $3 "" $8
          Goto cred_split_done
        ${EndIf}
        IntOp $6 $6 + 1
        Goto cred_split
      cred_split_done:
      StrCpy $CredState "OK"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function WriteRegEntries
  WriteRegStr HKLM "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${APP_KEY}" "Version" "${APP_VERSION}"

  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "qqbot"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "qqbot"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\assets\qqbot.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" "$0"
FunctionEnd

; 全部 Section 跑完之后收尾：这里能正确读到"哪些组件被勾选了"。
Function .onInstSuccess
  ${IfNot} ${SectionIsSelected} ${SEC_AUTOSTART}
    nsExec::Exec 'sc.exe config ${SVC_NAME} start= demand'
    Pop $0
    nsExec::Exec 'schtasks.exe /Change /TN "qqbot-napcat" /DISABLE'
    Pop $0
    DetailPrint "已按你的选择关闭开机自启"
  ${EndIf}

  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\qqbot"
  WriteINIStr "$SMPROGRAMS\qqbot\qqbot 面板.url" "InternetShortcut" "URL" "http://127.0.0.1:5666"
  CreateShortCut "$SMPROGRAMS\qqbot\qqbot 命令行.lnk" "$SYSDIR\cmd.exe" '/k "$INSTDIR\qqbot.cmd"' "$INSTDIR\assets\qqbot.ico"
  CreateShortCut "$SMPROGRAMS\qqbot\重启 qqbot 服务.lnk" "$INSTDIR\restart-service.cmd" "" "$INSTDIR\assets\qqbot.ico"
  ${If} ${SectionIsSelected} ${SEC_NAPCAT}
    CreateShortCut "$SMPROGRAMS\qqbot\启动协议端.lnk" "$INSTDIR\start-napcat.cmd" "" "$INSTDIR\assets\qqbot.ico"
  ${EndIf}
  CreateShortCut "$SMPROGRAMS\qqbot\面板凭据.lnk" "$DataRoot\logs\credentials.txt" "" "$INSTDIR\assets\qqbot.ico"
  CreateShortCut "$SMPROGRAMS\qqbot\卸载 qqbot.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\assets\qqbot.ico"
FunctionEnd

; ---------------- 完成页：出示凭据 ----------------

Function CredPageShow
  !insertmacro MUI_HEADER_TEXT "安装完成" "下一步：扫码登录 QQ，填模型接口"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 22u "面板地址：http://127.0.0.1:5666$\r$\n它只监听本机：请在这台机器的浏览器里打开，或通过远程桌面打开。"
  Pop $hLbl

  ${If} $CredPass != ""
    ${NSD_CreateLabel} 0 26u 100% 12u "管理员凭据（只显示这一次，已另存到 $DataRoot\logs\credentials.txt）："
    Pop $hLbl
    ${NSD_CreateText} 0 40u 100% 24u "$CredUser / $CredPass"
    Pop $hEdit
    SendMessage $hEdit ${EM_SETREADONLY} 1 0
  ${ElseIf} $CredState == "EXISTING"
    ${NSD_CreateLabel} 0 26u 100% 26u "检测到已有安装：面板密码沿用原来的，没有重置。$\r$\n忘了的话，用开始菜单「qqbot 命令行」执行 qqbot reset-password。"
    Pop $hLbl
  ${Else}
    ${NSD_CreateLabel} 0 26u 100% 30u "服务在 90 秒内没有就绪，暂时取不到初始密码。$\r$\n常见原因：端口 5666 被占用、服务账号权限不足。请看 $DataRoot\logs\qqbot.err.log。"
    Pop $hLbl
  ${EndIf}

  ${NSD_CreateLabel} 0 78u 100% 44u "还要做两件事：$\r$\n1) 让协议端跑起来：开始菜单 →「启动协议端」，然后在面板「登录」页扫码。$\r$\n2) 「全局设置」里填模型接口地址与 API Key，保存即生效。"
  Pop $hLbl

  ${NSD_CreateButton} 0 128u 62u 16u "打开面板"
  Pop $hBtn
  ${NSD_OnClick} $hBtn OpenPanel

  ${NSD_CreateButton} 70u 128u 62u 16u "打开数据目录"
  Pop $hBtn
  ${NSD_OnClick} $hBtn OpenDataDir

  nsDialogs::Show
FunctionEnd

Function OpenPanel
  ExecShell "open" "http://127.0.0.1:5666"
FunctionEnd

Function OpenDataDir
  ExecShell "open" "$DataRoot"
FunctionEnd

Function CredPageLeave
  ; 这一页不收集输入，直接放行
FunctionEnd

; ---------------- 卸载 ----------------

Function un.onInit
  ; 与安装器保持同一个注册表视图，否则卸载项删错位置会留下孤儿条目
  SetRegView 64
FunctionEnd

Section "Uninstall"
  SetShellVarContext all

  ; 先停服务再删文件，否则 node.exe 被占用删不掉
  ${If} ${FileExists} "$INSTDIR\service\${SVC_EXE}"
    nsExec::Exec '"$INSTDIR\service\${SVC_EXE}" stop'
    Sleep 1500
    nsExec::Exec '"$INSTDIR\service\${SVC_EXE}" uninstall'
    Sleep 500
  ${EndIf}

  nsExec::Exec 'schtasks.exe /Delete /TN "qqbot-napcat" /F'

  ; 只杀 NapCat 的引导进程，不动用户自己的 QQ
  nsExec::Exec 'taskkill.exe /F /IM NapCatWinBootMain.exe'

  ReadEnvStr $DataRoot "ProgramData"
  ${If} $DataRoot == ""
    StrCpy $DataRoot "C:\ProgramData"
  ${EndIf}
  StrCpy $DataRoot "$DataRoot\qqbot"

  ; 数据去留。静默卸载（/S）时不能弹窗等人点，默认保留数据 ——
  ; 删聊天记录这种事不该因为"没人看着"就自动发生。
  ; 无人值守要连数据一起删，显式传 /PURGE=1。
  ${GetParameters} $R0
  ${GetOptions} $R0 "/PURGE=" $R1
  StrCpy $R2 "0"
  ${If} ${Silent}
    ${If} $R1 == "1"
      StrCpy $R2 "1"
    ${EndIf}
  ${Else}
    MessageBox MB_YESNO|MB_DEFBUTTON2 "是否同时删除数据？$\r$\n$\r$\n包括：聊天记录、密钥、模型 API Key、QQ 登录态。$\r$\n选「否」会保留 $DataRoot，重装后可以接着用。" IDNO keep_data
    StrCpy $R2 "1"
  ${EndIf}

  keep_data:
  ${If} $R2 == "1"
    RMDir /r "$DataRoot"
    ; 服务账号只在彻底删除时移除；保留数据时留着，重装能复用同一个账号
    nsExec::Exec 'net.exe user qqbot_svc /delete'
  ${EndIf}

  Delete "$SMPROGRAMS\qqbot\qqbot 面板.url"
  Delete "$SMPROGRAMS\qqbot\qqbot 命令行.lnk"
  Delete "$SMPROGRAMS\qqbot\重启 qqbot 服务.lnk"
  Delete "$SMPROGRAMS\qqbot\启动协议端.lnk"
  Delete "$SMPROGRAMS\qqbot\面板凭据.lnk"
  Delete "$SMPROGRAMS\qqbot\卸载 qqbot.lnk"
  RMDir "$SMPROGRAMS\qqbot"

  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "${APP_KEY}"

  ; 自删：先删掉自己的副本再删目录，否则 uninstall.exe 正被自己占用
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
SectionEnd
