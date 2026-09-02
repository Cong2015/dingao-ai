@echo off
title 定稿AI v0.4 - 交稿之前，先定稿
cd /d "%~dp0"

REM node 路径兜底（系统PATH应有nodejs，此处双保险）
set "PATH=C:\Program Files\nodejs;%PATH%"

REM ---- 0. 服务已在运行？直接打开浏览器 ----
netstat -ano | findstr ":8788" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [OK] 服务已在运行，正在打开浏览器...
  start "" http://localhost:8788
  timeout /t 8 >nul
  exit
)

REM ---- 1. 防火墙放行（异步，不阻塞启动；首次弹 UAC 点"是"即可） ----
netsh advfirewall firewall show rule name="dingao-ai-8788" >nul 2>&1
if errorlevel 1 (
  netsh advfirewall firewall add rule name="dingao-ai-8788" dir=in action=allow protocol=TCP localport=8788 >nul 2>&1
  if errorlevel 1 (
    echo [防火墙] 已弹出管理员授权窗口：请点"是"放行（仅需一次，不影响服务启动）...
    start "" powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall add rule name=\"dingao-ai-8788\" dir=in action=allow protocol=TCP localport=8788' -Verb RunAs"
  ) else (
    echo [OK] 防火墙已放行 TCP 8788，局域网电脑可访问
  )
) else (
  echo [OK] 防火墙规则已存在
)

REM ---- 2. 启动服务（看门狗：异常退出 3 秒后自动重启） ----
echo [启动] 服务启动中，浏览器将自动打开...
start /b cmd /c "timeout /t 3 /nobreak >nul && start "" http://localhost:8788"
:loop
node server.js
echo.
echo [看门狗] %date% %time% 服务退出，3 秒后自动重启（关闭本窗口即停止服务）...
echo [看门狗] %date% %time% 服务退出 >> logs\watchdog.log
timeout /t 3 /nobreak >nul
goto loop