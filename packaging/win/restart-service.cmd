@echo off
rem 重启 qqbot 服务。开始菜单里的「重启 qqbot 服务」指向本文件。
rem 需要管理员：sc 改服务状态必须有权限，所以先自检再自提升（UAC 只弹一次）。
rem ASCII only：见 napcat-run.cmd 顶部说明。
setlocal
set "SVC=qqbot"

if /i "%~1"=="query" goto :query

net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
    exit /b 0
)

echo Stopping %SVC%...
sc stop %SVC% >nul 2>&1
call :wait_for STOPPED 20

echo Starting %SVC%...
sc start %SVC% >nul 2>&1
call :wait_for RUNNING 20

goto :query

:wait_for
setlocal EnableDelayedExpansion
set "WANT=%~1"
set /a LEFT=%~2
:wait_loop
sc query %SVC% | findstr /i "STATE" | findstr /i "%WANT%" >nul && (
    endlocal & exit /b 0
)
set /a LEFT-=1
if !LEFT! LEQ 0 ( endlocal & exit /b 1 )
timeout /t 1 /nobreak >nul
goto :wait_loop

:query
sc query %SVC% | findstr /i "SERVICE_NAME STATE"
echo.
echo Panel: http://127.0.0.1:5666
timeout /t 6 >nul
exit /b 0
