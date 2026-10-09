@echo off
cd /d "%~dp0"
title Anjani Market - Local Server

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Python tidak ditemukan di komputer ini.
    echo Install dulu dari: https://www.python.org/downloads/
    echo Centang "Add Python to PATH" saat instal.
    echo.
    pause
    exit /b 1
)

echo.
echo   Anjani Market sedang dijalankan...
echo   Alamat  : http://localhost:8000
echo   Folder  : %~dp0
echo.
echo   Tutup jendela server (atau tekan Ctrl+C) untuk berhenti.
echo.

start "AnjaniMarket-Server" /min python -m http.server 8000
timeout /t 2 /nobreak >nul
start "" http://localhost:8000
