@echo off
rem ---------------------------------------------------------------------------
rem Launcher wrapper for NapCat, invoked by the qqbot-napcat scheduled task
rem after a user logs on.
rem
rem Why not the stock launcher.bat:
rem   1) It self-checks with `net session` and re-launches through
rem      launcher-elevate.ps1 (UAC) when not elevated. A scheduled task runs
rem      silently, so that UAC prompt is never answered and the protocol side
rem      never comes up.
rem   2) Its failure branches end with `pause`, so the task hangs forever
rem      waiting for a key press - looks like "started but nothing happens".
rem   3) It depends on wt.exe (Windows Terminal), absent on Server by default.
rem This replicates the elevated branch: set the same env vars and call
rem NapCatWinBootMain.exe directly.
rem
rem QQ.exe lookup order (the stock launcher only knows the first one, which is
rem not enough in practice):
rem   1) environment variable QQBOT_QQ_EXE
rem   2) qq-path.txt next to this script - written at install time; edit that
rem      one line if QQ moves
rem   3) Uninstall\QQ registry key (32- and 64-bit views)
rem   4) App Paths\QQ.exe
rem   5) usual install directories
rem   6) path of a running QQ process
rem Without 2) and 6), a QQ installed to a custom directory with no uninstall
rem entry is reported as "not installed" and the protocol side never starts.
rem
rem IMPORTANT: keep this file ASCII-only. cmd.exe reads .bat/.cmd with the
rem OEM/ANSI code page, so UTF-8 CJK comments get mangled and are executed as
rem commands. All user-facing Chinese lives in the installer and the README.
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

set "QQPath="

rem ---- 1) environment variable ----
if defined QQBOT_QQ_EXE call :qq_try "%QQBOT_QQ_EXE%"
if defined QQPath goto :qq_found

rem ---- 2) qq-path.txt ----
rem The file is UTF-8 with BOM and normally starts with # comment lines. Comments
rem are not parsed: a candidate only counts if it ends in .exe and exists, so
rem they filter themselves out. Keep the comment lines - they absorb the BOM.
set "QQPATHFILE=%~dp0qq-path.txt"
if not exist "%QQPATHFILE%" goto :qq_registry
for /f "usebackq delims=" %%L in ("%QQPATHFILE%") do (
    if not defined QQPath call :qq_try "%%~L"
)
if defined QQPath goto :qq_found

:qq_registry
rem ---- 3) uninstall registry entry ----
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString" 2^>nul') do (
    for %%d in ("%%~b") do call :qq_try "%%~dpdQQ.exe"
)
if defined QQPath goto :qq_found
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString" 2^>nul') do (
    for %%d in ("%%~b") do call :qq_try "%%~dpdQQ.exe"
)
if defined QQPath goto :qq_found

rem ---- 4) App Paths ----
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe" /ve 2^>nul') do (
    call :qq_try "%%~b"
)
if defined QQPath goto :qq_found
for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe" /ve 2^>nul') do (
    call :qq_try "%%~b"
)
if defined QQPath goto :qq_found

rem ---- 5) usual directories ----
call :qq_try "%ProgramFiles%\Tencent\QQNT\QQ.exe"
call :qq_try "%ProgramFiles(x86)%\Tencent\QQNT\QQ.exe"
call :qq_try "%LOCALAPPDATA%\Programs\Tencent\QQNT\QQ.exe"
if defined QQPath goto :qq_found

rem ---- 6) running QQ process ----
rem Only reached when everything above failed (QQ installed after qqbot, or
rem moved). A custom install directory is otherwise unreachable.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Process QQ -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path"`) do (
    if not defined QQPath call :qq_try "%%P"
)
if defined QQPath goto :qq_found

echo [%date% %time%] QQ.exe not found. Install QQ NT, or put its full path in %QQPATHFILE%
echo [%date% %time%] QQ.exe not found. Install QQ NT, or put its full path in %QQPATHFILE% >> "%LOGFILE%"
exit /b 2

:qq_found
if not exist "%QQPath%" (
    echo [%date% %time%] QQ.exe not found at %QQPath% >> "%LOGFILE%"
    exit /b 3
)

echo [%date% %time%] starting NapCat with %QQPath% >> "%LOGFILE%"
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%" %* >> "%LOGFILE%" 2>&1
set "RC=%ERRORLEVEL%"
echo [%date% %time%] NapCat exited with code %RC% >> "%LOGFILE%"
exit /b %RC%

rem ---- accept one candidate path; remember it when it is a real QQ.exe ----
:qq_try
set "_c=%~1"
if "%_c%"=="" goto :eof
set "_c=%_c:"=%"
if /i not "%_c:~-4%"==".exe" goto :eof
rem Tolerate up to 3 leading junk characters. If someone rewrites qq-path.txt and
rem drops the comment lines, cmd hands the UTF-8 BOM (3 bytes) over as part of
rem the first line; without this the file would look ignored.
set /a "_n=0"
:qq_try_strip
if exist "%_c%" goto :qq_try_hit
if %_n% GEQ 3 goto :eof
set /a "_n+=1"
set "_c=%_c:~1%"
goto :qq_try_strip

:qq_try_hit
set "QQPath=%_c%"
goto :eof
