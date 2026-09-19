@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title ClipForge - Build Installer
set "LOG=%~dp0installer-build.log"
set "CODE=0"

echo ============================================
echo   ClipForge - Build Installer
echo ============================================
echo   Workspace : %CD%
echo   Log       : %LOG%
echo.
echo   Environment switches:
echo     SKIP_CHECKS=1    skip typecheck and unit tests
echo     SKIP_BINARIES=1  keep the existing resources\bin payload
echo     NO_PAUSE=1       exit without waiting for a keypress
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem cmd.exe mis-executes a batch file with Unix line endings: it resumes at the wrong byte
rem offset after a nested batch call and silently skips whole sections, so the build would
rem run from a script whose flow cannot be trusted. Refuse to start from one.
if not exist "scripts\check-bat-eol.mjs" (
    echo   ERROR: scripts\check-bat-eol.mjs is missing; it checks that this script can run.
    set "CODE=1"
    goto :finish
)
node "scripts\check-bat-eol.mjs" "%~f0"
if errorlevel 1 (
    echo.
    echo   ERROR: this script has Unix line endings, which cmd.exe cannot follow.
    echo   Rewrite it with:  node scripts\check-bat-eol.mjs --fix
    set "CODE=1"
    goto :finish
)

for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VERSION=%%v"
echo   Node      : !NODE_VERSION!
echo   npm       : !NPM_VERSION!
echo.

call :ensure_modules
if errorlevel 1 goto :step_failed
call :repair_electron
if errorlevel 1 goto :step_failed

if /i "%~1"=="check" (
    echo.
    echo   Preflight only - nothing was built.
    goto :done
)

if /i "%SKIP_CHECKS%"=="1" goto :skip_checks

 echo   [1/4] Typechecking the main process and renderer...
call npm run typecheck
if errorlevel 1 goto :step_failed
call :mark "typecheck ok"

 echo.
 echo   [2/4] Running unit tests...
call npm test
if errorlevel 1 goto :step_failed
call :mark "tests ok"
goto :checks_done

:skip_checks
 echo   [1/4] Typecheck and tests : skipped ^(SKIP_CHECKS=1^)

:checks_done

echo.
if /i "%SKIP_BINARIES%"=="1" (
    echo   [3/4] Media binaries : skipped ^(SKIP_BINARIES=1^)
    echo         The installer will not bundle ffmpeg, yt-dlp or gifski.
) else (
    echo   [3/4] Preparing media binaries ^(ffmpeg, ffprobe, yt-dlp, gifski^)...
    echo         The FFmpeg archive is roughly 110 MB on the first run.
    call npm run prepare:binaries
    if errorlevel 1 goto :binaries_failed
    call :mark "media binaries ok"
)

echo.
echo   [4/4] Building and packaging the NSIS installer...
call npm run build
if errorlevel 1 goto :step_failed
call npx electron-builder --win nsis
if errorlevel 1 goto :package_failed
call :mark "installer packaged"

if not exist "release\ClipForge-Setup-*.exe" goto :no_artifact
for %%F in ("release\ClipForge-Setup-*.exe") do set "ARTIFACT=%%~fF"

:done
echo.
if defined ARTIFACT (
    echo   INSTALLER BUILD SUCCEEDED
    for %%F in ("!ARTIFACT!") do echo   File      : !ARTIFACT!  ^(%%~zF bytes^)
    echo   Bundled   : resources\bin ships inside the installed resources folder
    >>"%LOG%" echo [%DATE% %TIME%] installer ok: !ARTIFACT!
) else (
    echo   Done.
)
goto :finish

:no_node
echo   ERROR: Node.js was not found on PATH.
echo   Install Node.js 20 or newer from https://nodejs.org and try again.
set "CODE=1"
goto :finish

:step_failed
echo.
echo   BUILD FAILED. Review the messages above.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] build FAILED
goto :finish

:binaries_failed
echo.
echo   ERROR: could not prepare the media binaries.
echo   Set SKIP_BINARIES=1 to package without them, or retry once the network is available.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] prepare:binaries FAILED
goto :finish

:package_failed
echo.
echo   ERROR: electron-builder failed.
echo   If it reports a problem extracting Electron, run: node scripts\repair-electron.mjs
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] electron-builder FAILED
goto :finish

:no_artifact
echo.
echo   ERROR: electron-builder finished but release\ClipForge-Setup-*.exe is missing.
set "CODE=1"
goto :finish

:finish
echo.
if /i "%NO_PAUSE%"=="1" exit /b !CODE!
echo Press any key to close this window...
pause >nul
exit /b !CODE!

rem ---------------------------------------------------------------- helpers

:mark
>>"%LOG%" echo [%DATE% %TIME%] %~1
exit /b 0

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
