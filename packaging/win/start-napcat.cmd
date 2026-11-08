@echo off
rem 手动启动 NapCat 协议端（等于手动跑一次登录后自启的计划任务）。
rem NapCat 需要管理员权限注入 QQ，所以计划任务用 HighestAvailable；
rem 这里也从计划任务起，避免直接运行时弹一次 UAC。
rem ASCII only：见 napcat-run.cmd 顶部说明。
setlocal
schtasks /run /tn "qqbot-napcat" >nul 2>&1
if errorlevel 1 (
    echo Task qqbot-napcat not found. Reinstall with the NapCat component selected.
    timeout /t 6 >nul
    exit /b 1
)
echo NapCat starting (see %ProgramData%\qqbot\logs\napcat.log).
echo Scan the QR code from the panel: http://127.0.0.1:5666
timeout /t 6 >nul
exit /b 0
