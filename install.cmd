@echo off
rem UPP one-click bootstrap for Windows (double-click or run in cmd).
rem Installs the global `upp` command (with uppenv / upptool / uppmem), then self-checks.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node.js 20 LTS or newer first: https://nodejs.org/
  pause
  exit /b 1
)

node -e "const m=+process.versions.node.split('.')[0]; if (m<20) { console.error('Node '+process.versions.node+' is too old, need >= 20'); process.exit(1) }"
if errorlevel 1 (
  echo [X] Please upgrade Node.js to 20 LTS or newer.
  pause
  exit /b 1
)

echo [1/3] Installing the global command `upp` ...
node "%~dp0tools\upp.mjs" setup-cli
if errorlevel 1 (
  echo [X] setup-cli failed. See the JSON above.
  pause
  exit /b 1
)

echo.
echo [2/3] Self-check ...
node "%~dp0tools\upp.mjs" doctor

echo.
echo [3/3] Done.
echo   Open a NEW terminal, then try:
echo     upp --version
echo     upp mem add "我的偏好：用中文回答" --kind preference --key user.language
echo     upp mem sync --host dsh,workbuddy,accio --both
echo     upp init my-plugin
echo.
echo   Docs: docs\19-quickstart.md
pause
