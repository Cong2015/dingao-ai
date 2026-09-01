@echo off
chcp 65001 >nul
title 定稿AI v0.3 - 交稿之前，先定稿
cd /d "%~dp0"

echo ==============================================
echo   定稿AI v0.3 - 交稿之前，先定稿
echo ==============================================

REM ---- 0. 服务已在运行？直接打开浏览器 ----
netstat -ano | findstr ":8788" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [OK] 服务已在运行，正在打开浏览器...
  start "" http://localhost:8788
  timeout /t 8
  exit
)

REM ---- 1. 防火墙放行（其他电脑访问必需；仅首次需管理员权限） ----
netsh advfirewall firewall show rule name="dingao-ai-8788" >nul 2>&1
if errorlevel 1 (
  echo [防火墙] 未检测到放行规则，尝试添加（如弹出 UAC 请点"是"，仅需一次）...
  netsh advfirewall firewall add rule name="dingao-ai-8788" dir=in action=allow protocol=TCP localport=8788 >nul 2>&1
  if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall add rule name=\"dingao-ai-8788\" dir=in action=allow protocol=TCP localport=8788' -Verb RunAs -Wait"
  )
  netsh advfirewall firewall show rule name="dingao-ai-8788" >nul 2>&1
  if errorlevel 1 (
    echo [警告] 防火墙规则仍未添加：其他电脑将无法访问。可右键本脚本"以管理员身份运行"，或手动执行：
    echo   netsh advfirewall firewall add rule name="dingao-ai-8788" dir=in action=allow protocol=TCP localport=8788
  ) else (
    echo [OK] 防火墙已放行 TCP 8788，局域网电脑可访问
  )
) else (
  echo [OK] 防火墙规则已存在
)

REM ---- 2. 启动服务（看门狗：异常退出 3 秒后自动重启） ----
echo [启动] 服务启动中... 启动完成后自动打开浏览器。
echo        局域网地址以窗口输出为准（IP 变化时会自动显示新地址）。
start /b cmd /c "timeout /t 3 /nobreak >nul && start "" http://localhost:8788"
:loop
node server.js
echo.
echo [看门狗] %date% %time% 服务退出，3 秒后自动重启（关闭本窗口即停止服务）...
echo [看门狗] %date% %time% 服务退出 >> logs\watchdog.log
timeout /t 3 /nobreak >nul
goto loop
