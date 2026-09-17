@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title ClipForge - Run
set "LOG=%~dp0run.log"
set "CODE=0"

echo ============================================
echo   ClipForge - Run
echo ============================================
echo   Workspace : %CD%
echo   Log       : %LOG%
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VERSION=%%v"
echo   Node      : !NODE_VERSION!
echo   npm       : !NPM_VERSION!
echo.

call :ensure_modules
if errorlevel 1 goto :failed
call :repair_electron
if errorlevel 1 goto :failed
call :ensure_dist
if errorlevel 1 goto :failed

if /i "%~1"=="check" (
    echo.
    echo   Preflight only - nothing was launched.
    goto :done
)

if /i "%~1"=="dev" (
    echo   Mode      : development ^(Vite dev server + Electron^)
    echo   Stop with : Ctrl+C
    echo.
    call npm run dev
    set "CODE=!errorlevel!"
) else (
    echo   Mode      : production build ^(compiled renderer^)
    echo.
    set "CLIPFORGE_DEV=0"
    call npx electron .
    set "CODE=!errorlevel!"
)

:done
echo.
if "!CODE!"=="0" (
    echo   ClipForge exited normally.
) else (
    echo   ClipForge exited with code !CODE! - see the output above.
)
>>"%LOG%" echo [%DATE% %TIME%] run finished, exit code !CODE!, arg=%~1
goto :finish

:no_node
echo   ERROR: Node.js was not found on PATH.
echo   Install Node.js 20 or newer from https://nodejs.org and try again.
set "CODE=1"
goto :finish

:failed
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] preflight failed

:finish
echo.
if /i "%NO_PAUSE%"=="1" exit /b !CODE!
echo Press any key to close this window...
pause >nul
exit /b !CODE!

rem ---------------------------------------------------------------- helpers

:ensure_modules
if exist "node_modules\electron\package.json" (
    echo   Dependencies : present
    exit /b 0
)
echo   Dependencies : installing with npm install ^(this can take a few minutes^)...
echo.
call npm install
if errorlevel 1 (
    echo.
    echo   ERROR: npm install failed.
    >>"%LOG%" echo [%DATE% %TIME%] npm install FAILED
    exit /b 1
)
>>"%LOG%" echo [%DATE% %TIME%] npm install ok
exit /b 0

:repair_electron
echo   Checking the Electron binary...
call node "scripts\repair-electron.mjs"
if errorlevel 1 (
    echo.
    echo   ERROR: the Electron binary is unavailable.
    exit /b 1
)
exit /b 0

:ensure_dist
if exist "dist\main\index.js" if exist "dist\renderer\index.html" (
    echo   Build        : up to date
    exit /b 0
)
echo   Build        : compiling ^(npm run build^)...
echo.
call npm run build
if errorlevel 1 (
    echo.
    echo   ERROR: npm run build failed.
    >>"%LOG%" echo [%DATE% %TIME%] npm run build FAILED
    exit /b 1
)
>>"%LOG%" echo [%DATE% %TIME%] npm run build ok
exit /b 0
