@echo off
title Stop Screen Monitor
cd /d "%~dp0"

echo ================================================================
echo    Stopping Screen Monitor and ngrok services...
echo ================================================================
echo.

taskkill /f /im ngrok.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo [*] All Screen Monitor server and ngrok tunnel instances stopped.
echo.
timeout /t 2 /nobreak >nul
