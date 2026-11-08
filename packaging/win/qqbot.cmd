@echo off
rem qqbot 命令行包装。开始菜单里的「qqbot 命令行」就是启动 cmd 后调它。
rem 用法： qqbot status / doctor / reset-password / version
rem ASCII only：见 napcat-run.cmd 顶部说明。
setlocal
set "QQBOT_ROOT=%ProgramData%\qqbot"
"%~dp0node\node.exe" "%~dp0dist\server.js" %*
