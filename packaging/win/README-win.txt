qqbot —— 快速上手
==================

1. 打开面板
   开始菜单 →「qqbot 面板」，或直接在浏览器里打开：
       http://127.0.0.1:5666

   面板只监听本机。要从别的电脑访问，改 %ProgramData%\qqbot\etc\qqbot.toml 里的
   panel.listen 为 "0.0.0.0:5666"，然后运行开始菜单里的「重启 qqbot 服务」，
   并自己承担把它暴露到网络的风险（面板有登录，但更安全的做法是走隧道或反代）。

2. 登录 QQ
   协议端（NapCat）装完不会自动启动——拉起它会重启本机 QQ。
   开始菜单 →「启动协议端」，等十几秒，然后在面板「登录」页扫码。

   注意：NapCat 需要机器上已安装 QQ NT（im.qq.com）。Windows Server 必须是
   「桌面体验」版本并保持有人登录，QQ 是图形程序，没有桌面会话起不来。

   QQ 装在自定义目录（比如 D:\qq）、或者装完这套之后才装 QQ 时，协议端可能
   找不到 QQ.exe。这时把 QQ.exe 的完整路径写进
   %ProgramData%\qqbot\napcat\qq-path.txt 单独一行即可（安装时探测到的路径
   已经在那里了，换过位置就改那一行）。日志在 %ProgramData%\qqbot\logs\napcat.log。

3. 配模型
   面板「全局设置」→ 填接口地址（OpenAI 兼容）与 API Key，保存即生效。

4. 忘了面板密码
   开始菜单 →「qqbot 命令行」，执行：
       qqbot reset-password

文件都在哪
----------
程序（只读）      C:\Program Files\qqbot
数据（可写）      %ProgramData%\qqbot
  etc\qqbot.toml        端口、时区、协议端地址
  etc\secrets.env       加密密钥与 OneBot/WebUI 令牌 —— 丢了等于丢数据，请备份
  data\qqbot\qqbot.db   聊天记录与设置
  data\qqbot\images\    图池
  logs\                 运行日志与初始凭据
  backup\               备份目录（安装包不自动备份，自己放）

改了配置怎么生效
----------------
  etc\qqbot.toml / etc\secrets.env  →  开始菜单「重启 qqbot 服务」
  面板里的设置                       →  保存即生效，不用重启

出问题看哪里
------------
  %ProgramData%\qqbot\logs\qqbot-svc.out.log    正常输出（含初始密码横幅）
  %ProgramData%\qqbot\logs\qqbot-svc.err.log    错误，服务起不来先看这个
  %ProgramData%\qqbot\logs\napcat.log           协议端日志
  %TEMP%\qqbot-install.log                      上次安装/卸载干了什么（哪步失败）
  %TEMP%\qqbot-account.log                      服务账号与目录权限的逐步记录
  开始菜单「qqbot 命令行」→ qqbot doctor        环境自检
  开始菜单「qqbot 命令行」→ qqbot status        配置与数据目录概览

  程序目录里带 tools\verify.mjs，装完之后可以跑一遍完整验收
  （服务账号、面板、端口、计划任务、权限），不需要管理员：
       "C:\Program Files\qqbot\node\node.exe" "C:\Program Files\qqbot\tools\verify.mjs"

静默安装与卸载
--------------
  管理员命令行下：
       qqbot-<版本>-setup.exe /S                静默安装（在 Program Files 里）
       "C:\Program Files\qqbot\uninstall.exe" /S        静默卸载，保留数据
       "C:\Program Files\qqbot\uninstall.exe" /S /PURGE=1   连数据一起删

  静默卸载默认**保留** %ProgramData%\qqbot：删聊天记录不该因为没人看着就自动发生。
  要连数据一起删，必须显式写 /PURGE=1。

常见症状
--------
  服务刚启动就停   看 err.log；多半是数据目录权限或 QQBOT_SECRET_KEY 格式不对
  面板打得开但没登录页   端口被别的程序占了，看 precheck 的提示
  扫码后一直"未连接"    协议端没起（启动协议端），或 3001 端口被占用
  时间差 8 小时     云主机默认 UTC；确认 etc\qqbot.toml 里 [time] zone 是 Asia/Shanghai
  重装后忘了密码    密码沿用旧的，不会重置；真忘了用「qqbot 命令行」→ qqbot reset-password

关于"电脑操作"功能
------------------
服务以专用低权限账号 qqbot_svc 运行，它只能写自己的数据目录，碰不到系统目录。
这个账号不在管理员组里；不要把机器人加进去——那等于把整机权限交给模型。
