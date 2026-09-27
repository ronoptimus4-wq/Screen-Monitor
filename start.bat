@echo off
title Screen Monitor - Agent Edition (Port 5000)
cd /d "%~dp0"

echo ================================================================
echo    Shield Screen Monitor - Agent Edition
echo    Port: 5000
echo    Domain: https://chunk-refinance-breeching.ngrok-free.dev
echo ================================================================
echo.

:: Ensure local Node.js and ngrok paths are recognized
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Microsoft\WindowsApps;%ProgramFiles%\WindowsApps;%PATH%"
set "PORT=5000"
set "NGROK_DOMAIN=chunk-refinance-breeching.ngrok-free.dev"

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Step 0: Clean up any stale ngrok or port 5000 processes to prevent ERR_NGROK_334 & EADDRINUSE
echo [*] Cleaning up previous ngrok and port 5000 processes...
taskkill /f /im ngrok.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5000 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

:: Step 1: Start Screen Monitor Server on port 5000 FIRST so ngrok has an active service to connect to
echo [1/3] Starting Screen Monitor Server on port 5000...
start "Screen Monitor - Node Server (Port 5000)" cmd /k "node server.js"
timeout /t 2 /nobreak >nul

:: Step 2: Start ngrok tunnel window
where ngrok >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [WARNING] ngrok was not found in PATH.
    echo You can still access locally at http://localhost:5000/parent
) else (
    echo [2/3] Launching ngrok tunnel on port 5000...
    start "ngrok - Port 5000 Tunnel" cmd /k "ngrok http 5000 --url https://chunk-refinance-breeching.ngrok-free.dev"
    timeout /t 2 /nobreak >nul
)

:: Step 3: Open Parent Dashboard in browser
echo [3/3] Opening Parent Dashboard in browser...
start https://chunk-refinance-breeching.ngrok-free.dev/parent

echo.
echo ================================================================
echo    Screen Monitor is running!
echo    - Parent URL: https://chunk-refinance-breeching.ngrok-free.dev/parent
echo    - Child URL:  https://chunk-refinance-breeching.ngrok-free.dev/child
echo    - Local URL:  http://localhost:5000/parent
echo.
echo    Tip: Double-click stop.bat at any time to stop all services.
echo ================================================================
echo.
pause
