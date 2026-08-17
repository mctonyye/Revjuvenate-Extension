@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH. Install from https://nodejs.org
  exit /b 1
)

echo [1/5] Installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo [2/5] Generating icons...
call npm run icons
if errorlevel 1 goto :fail

echo [3/5] Building extension...
call npm run build
if errorlevel 1 goto :fail

echo [4/5] Initializing git repository...
if exist .git (
  echo Git repository already exists - skipping init.
) else (
  git init
  if errorlevel 1 goto :fail
)

echo [5/5] Creating initial commit...
git add -A
git commit -m "Phase 1: extension scaffold - MV3 manifest, side panel, Supabase auth via service worker"
if errorlevel 1 (
  echo.
  echo Commit failed. If git identity is not set, run:
  echo   git config user.name "Your Name"
  echo   git config user.email "you@example.com"
  echo then: git add -A ^&^& git commit -m "Phase 1 scaffold"
  exit /b 1
)

echo.
echo Done. Load the extension from the "dist" folder:
echo   Chrome:  chrome://extensions  -  Developer mode  -  Load unpacked
echo   Edge:    edge://extensions   -  Developer mode  -  Load unpacked
exit /b 0

:fail
echo.
echo Setup failed - see error above.
exit /b 1