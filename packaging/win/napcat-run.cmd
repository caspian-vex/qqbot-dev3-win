@echo off
rem ---------------------------------------------------------------------------
rem qqbot 的 NapCat 启动包装（由计划任务在用户登录后调用）。
rem
rem 为什么不直接用官方 launcher.bat：
rem   1) 它用 `net session` 自检，非管理员会去调 launcher-elevate.ps1 弹 UAC。
rem      计划任务是静默执行的，弹出来的 UAC 没人点，协议端就永远起不来。
rem   2) 它的失败分支带 `pause`，计划任务会一直挂在那里等回车，看起来像"启动了但没反应"。
rem   3) 它依赖 wt.exe（Windows Terminal），Server 版默认没装。
rem 所以这里复刻它的管理员分支：设好同样的环境变量，直接调 NapCatWinBootMain.exe。
rem
rem 注意：本文件刻意只写 ASCII。中文 Windows 的 cmd 按当前代码页读 .bat，
rem UTF-8 中文会变成乱码；要给人看的中文都在安装器和 README 里。
rem ---------------------------------------------------------------------------
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
chcp 65001 >nul

set "LOGFILE=%~dp0..\logs\napcat.log"

set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%cd%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"

set "RetString="
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString" 2^>nul') do (
    set "RetString=%%~b"
    goto :got_qq
)
echo [%date% %time%] QQ not found in registry (QQ NT is required) >> "%LOGFILE%"
exit /b 2

:got_qq
for %%a in ("%RetString%") do set "QQPath=%%~dpaQQ.exe"
if not exist "%QQPath%" (
    echo [%date% %time%] QQ.exe not found at %QQPath% >> "%LOGFILE%"
    exit /b 3
)

echo [%date% %time%] starting NapCat with %QQPath% >> "%LOGFILE%"
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%" %* >> "%LOGFILE%" 2>&1
set "RC=%ERRORLEVEL%"
echo [%date% %time%] NapCat exited with code %RC% >> "%LOGFILE%"
exit /b %RC%
