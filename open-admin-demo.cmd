@echo off
setlocal

cd /d "%~dp0"
set "ADMIN_FILE=%~dp0admin.html?dev=1"

if not exist "%~dp0admin.html" (
  echo Cannot find admin.html.
  echo Current folder: %cd%
  pause
  exit /b 1
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%ADMIN_FILE%"
  exit /b 0
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%ADMIN_FILE%"
  exit /b 0
)

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%ADMIN_FILE%"
  exit /b 0
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "%ADMIN_FILE%"
  exit /b 0
)

explorer "%ADMIN_FILE%"
