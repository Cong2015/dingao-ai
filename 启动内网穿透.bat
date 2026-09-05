@echo off
title 定稿AI - 内网穿透（cpolar）
cd /d "%~dp0"
echo 启动内网穿透：把 8788 端口映射到公网...
echo 首次使用需先注册 cpolar 账号并执行一次 authtoken（见下方网址）
echo 注册: https://dashboard.cpolar.com/signup   Token: https://dashboard.cpolar.com/auth
:loop
%USERPROFILE%\cpolar.log 2>&1
echo [看门狗] %date% %time% 穿透退出，3 秒后自动重启（关闭本窗口即停止穿透）
echo [看门狗] %date% %time% 穿透退出 >> logs\cpolar.log
timeout /t 3 /nobreak >nul
goto loop