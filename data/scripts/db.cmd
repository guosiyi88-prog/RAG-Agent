@echo off
rem Windows wrapper for scripts/db.sh (CMD / PowerShell)
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=!SCRIPT_DIR:\=/!"

set "BASH="
for /f "delims=" %%i in ('where bash 2^>nul') do (
  if not defined BASH set "BASH=%%i"
)
if not defined BASH if exist "C:\Program Files\Git\bin\bash.exe" set "BASH=C:\Program Files\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"

if not defined BASH (
  echo [x] bash not found. Please install Git for Windows or run scripts/db.sh from Git Bash.
  exit /b 1
)

"!BASH!" "!SCRIPT_DIR!db.sh" %*
exit /b %ERRORLEVEL%
