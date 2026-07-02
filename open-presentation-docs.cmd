@echo off
setlocal

cd /d "%~dp0"

if not exist "docs\PROJECT_SUMMARY.md" (
  echo Cannot find docs\PROJECT_SUMMARY.md.
  pause
  exit /b 1
)

start "" "%~dp0docs\README.md"
start "" "%~dp0docs\PROJECT_SUMMARY.md"
start "" "%~dp0docs\PRESENTATION_GUIDE.md"
start "" "%~dp0docs\QA_CHECKLIST.md"
start "" "%~dp0docs\DEMO_SCENARIO.md"
start "" "%~dp0docs\TECHNICAL_OVERVIEW.md"
