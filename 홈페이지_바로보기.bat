@echo off
cd /d "%~dp0"

if not exist "index.html" (
  echo Cannot find index.html.
  echo Current folder: %cd%
  pause
  exit /b 1
)

call "%~dp0open-homepage.cmd"
