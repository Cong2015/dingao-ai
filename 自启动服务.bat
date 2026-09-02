@echo off
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
REM 开机自启辅助：端口已被占用（例如手动窗口已在运行）则直接退出
netstat -ano | findstr ":8788" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 exit /b
:loop
node server.js >> logs\autostart.log 2>&1
timeout /t 3 /nobreak >nul
goto loop