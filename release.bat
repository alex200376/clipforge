@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title ClipForge - Push, Build ^& Release
set "LOG=%~dp0release.log"
set "CODE=0"
set "TAG=1"
rem Set by the commit, push and tag steps, then proved again before anything is published,
rem so a run that skipped them cannot reach the release.
set "DID_COMMIT="
set "DID_PUSH="
set "DID_TAG="

echo ============================================
echo   ClipForge - Push, Build ^& Release
echo ============================================
echo   Workspace : %CD%
echo   Log       : %LOG%
echo.
echo   Commits, pushes, builds the NSIS installer and publishes it as a
echo   GitHub release so installed copies can update themselves.
echo.
echo   Usage:
echo     release.bat              full run
echo     release.bat check        preflight only - nothing is committed or published
echo.
echo   Environment switches:
echo     REPO=owner/name          GitHub repository to create or attach and release to
echo     VERSION=1.2.3            set package.json to this version before committing
echo     PUBLIC=1                 create a new repository as public instead of private
echo     SKIP_CHECKS=1            skip typecheck and unit tests
echo     SKIP_BINARIES=1          keep the existing resources\bin payload
echo     NO_TAG=1                 commit and push, then stop before building or publishing
echo     COMMIT_MSG="..."         override the generated commit message
echo     NO_PAUSE=1               exit without waiting for a keypress
echo.
echo   A GitHub token is required to publish. Set GH_TOKEN, or sign in once with
echo   the GitHub CLI ^(gh auth login^) and this script will reuse that token.
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

rem cmd.exe mis-executes a batch file with Unix line endings: it resumes at the wrong byte
rem offset after a nested batch call and silently skips whole sections. That is how this
rem script once published a release whose commit, push and tag steps had never run. Refuse
rem to start from such a file, while refusing is still cheap.
if not exist "scripts\check-bat-eol.mjs" (
    echo   ERROR: scripts\check-bat-eol.mjs is missing, so this script cannot prove that
    echo   cmd.exe will execute it in order. Restore it before releasing.
    set "CODE=1"
    goto :finish
)
node "scripts\check-bat-eol.mjs" "%~f0"
if errorlevel 1 (
    echo.
    echo   ERROR: this script has Unix line endings, which cmd.exe cannot follow.
    echo   It would skip whole sections while later ones still ran, which is how a
    echo   release gets published without its commit, push or tag. Rewrite it with:
    echo     node scripts\check-bat-eol.mjs --fix
    set "CODE=1"
    >>"%LOG%" echo [%DATE% %TIME%] release refused, LF line endings
    goto :finish
)

where git >nul 2>nul
if errorlevel 1 goto :no_git
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VERSION=%%v"
for /f "delims=" %%v in ('git --version') do set "GIT_VERSION=%%v"
echo   Node      : !NODE_VERSION!
echo   npm       : !NPM_VERSION!
echo   !GIT_VERSION!
echo.

if /i "%NO_TAG%"=="1" set "TAG=0"

call :ensure_modules
if errorlevel 1 goto :failed
call :repair_electron
if errorlevel 1 goto :failed
call :ensure_repo
if errorlevel 1 goto :failed
call :resolve_remote
if errorlevel 1 goto :failed
call :resolve_token
if errorlevel 1 goto :failed
call :resolve_version
if errorlevel 1 goto :failed

echo   Repository: !OWNER!/!REPO_NAME!
echo   Version   : !VERSION!  ^(release tag v!VERSION!^)
if "!TAG!"=="0" echo   Tagging   : disabled ^(NO_TAG=1^)
echo   Token     : !TOKEN_STATE!
echo.

if /i "%~1"=="check" (
    echo   Preflight only - nothing was committed, tagged or published.
    goto :done
)

if /i "%SKIP_CHECKS%"=="1" goto :skip_checks

 echo   [1/6] Typechecking the main process and renderer...
call npm run typecheck
if errorlevel 1 goto :step_failed
call :mark "typecheck ok"

 echo.
 echo   [2/6] Running unit tests...
call npm test
if errorlevel 1 goto :step_failed
call :mark "tests ok"
goto :checks_done

:skip_checks
 echo   [1/6] Typecheck and tests : skipped ^(SKIP_CHECKS=1^)

:checks_done

echo.
echo   [3/6] Committing the working tree...
call :commit
if errorlevel 1 goto :failed
set "DID_COMMIT=1"

echo.
echo   [4/6] Pushing to !OWNER!/!REPO_NAME!...
git push origin HEAD
if errorlevel 1 (
    rem A brand new repository has no upstream yet; set it and try once more.
    echo         No upstream - retrying with --set-upstream...
    git push --set-upstream origin HEAD
    if errorlevel 1 goto :push_failed
)
call :mark "pushed"
set "DID_PUSH=1"

if "!TAG!"=="0" goto :no_tag
call :tag
if errorlevel 1 goto :finish

echo.
if /i "%SKIP_BINARIES%"=="1" (
    echo   [5/6] Media binaries : skipped ^(SKIP_BINARIES=1^)
    echo         The installer will not bundle ffmpeg, yt-dlp or gifski.
) else (
    echo   [5/6] Preparing media binaries ^(ffmpeg, ffprobe, yt-dlp, gifski^)...
    echo         The FFmpeg archive is roughly 110 MB on the first run.
    call npm run prepare:binaries
    if errorlevel 1 goto :binaries_failed
    call :mark "media binaries ok"
)

rem Prove this run reached here in order before it may publish. cmd.exe can resume a batch
rem file at the wrong offset and skip whole sections without a word, and the sections it
rem skips are exactly the ones that keep a release honest - so anything missing here stops
rem the run instead of publishing something that does not match git.
if not "!DID_COMMIT!"=="1" goto :steps_skipped
if not "!DID_PUSH!"=="1" goto :steps_skipped
if "!TAG!"=="1" if not "!DID_TAG!"=="1" goto :steps_skipped

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
for /f "delims=" %%h in ('git rev-parse HEAD') do set "LOCAL_HEAD=%%h"
set "REMOTE_HEAD="
for /f "delims=" %%h in ('git rev-parse "refs/remotes/origin/!BRANCH!" 2^>nul') do set "REMOTE_HEAD=%%h"
if not "!LOCAL_HEAD!"=="!REMOTE_HEAD!" goto :not_pushed
for /f "delims=" %%s in ('git status --porcelain') do goto :dirty_tree

rem A release is only as good as the tag it points at, so make sure the tag exists on the
rem remote as well as locally - a local-only tag means GitHub would tag the wrong commit.
if not "!TAG!"=="1" goto :tag_checked
git rev-parse -q --verify "refs/tags/v!VERSION!" >nul
if errorlevel 1 goto :no_tag_ref
set "REMOTE_TAG="
for /f "delims=" %%t in ('git ls-remote --tags origin "refs/tags/v!VERSION!" 2^>nul') do set "REMOTE_TAG=%%t"
if not defined REMOTE_TAG goto :no_tag_ref
:tag_checked

echo.
echo   [6/6] Building and publishing the GitHub release...
echo         The installer is uploaded to the v!VERSION! release and the
echo         update feed lands beside it, which is what installed copies read.
call npm run build
if errorlevel 1 goto :step_failed
rem A stale installer from a previous run would make the checks below pass for the
rem wrong reason, so the release folder starts clean.
if exist "release\latest.yml" del /q "release\latest.yml"
del /q "release\ClipForge-Setup-*.exe" >nul 2>nul
if not exist "build\icon.ico" (
    echo         Generating the app icon...
    call npm run make:icon
    if errorlevel 1 goto :step_failed
)
call npm run release -- -c.publish.owner=!OWNER! -c.publish.repo=!REPO_NAME!
if errorlevel 1 goto :package_failed
call :mark "release v!VERSION! published"

if not exist "release\latest.yml" goto :no_feed
for %%F in ("release\ClipForge-Setup-*.exe") do set "ARTIFACT=%%~fF"
if not defined ARTIFACT goto :no_artifact

:done
echo.
if defined ARTIFACT (
    echo   RELEASE SUCCEEDED
    for %%F in ("!ARTIFACT!") do echo   Installer : !ARTIFACT!  ^(%%~zF bytes^)
    echo   Feed      : release\latest.yml  ^(read by the in-app updater^)
    echo   Release   : https://github.com/!OWNER!/!REPO_NAME!/releases/tag/v!VERSION!
    >>"%LOG%" echo [%DATE% %TIME%] release ok: v!VERSION! !ARTIFACT!
) else (
    echo   Done.
)
goto :finish

:no_node
echo   ERROR: Node.js was not found on PATH.
echo   Install Node.js 20 or newer from https://nodejs.org and try again.
set "CODE=1"
goto :finish

:no_git
echo   ERROR: git was not found on PATH.
echo   Install Git for Windows from https://git-scm.com and try again.
set "CODE=1"
goto :finish

:no_repo
echo   ERROR: this folder is not a git repository yet.
echo.
echo   Point it at the repository that should hold the releases:
echo     set REPO=your-user/clipforge
echo     release.bat
echo.
echo   With REPO set, this script creates the repository with the GitHub CLI when it
echo   is available ^(private unless PUBLIC=1^), or initialises one and adds the
echo   remote so the first commit can be pushed.
set "CODE=1"
goto :finish

:step_failed
echo.
echo   FAILED. Review the messages above.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] release FAILED
goto :finish

:failed
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] release preflight FAILED
goto :finish

:push_failed
echo.
echo   ERROR: git could not push to !OWNER!/!REPO_NAME!.
echo   Check the remote ^(git remote -v^) and that your credentials can write to it.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] git push FAILED
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
echo   ERROR: electron-builder could not build or publish.
echo   If it reports a problem extracting Electron: node scripts\repair-electron.mjs
echo   If it reports an authentication or 404 problem: check GH_TOKEN and REPO.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] electron-builder publish FAILED
goto :finish

:no_feed
echo.
echo   ERROR: the build finished but release\latest.yml is missing.
echo   Without it no installed copy can see the new version. Re-run so
echo   electron-builder writes the update metadata.
set "CODE=1"
goto :finish

:no_artifact
echo.
echo   ERROR: electron-builder finished but release\ClipForge-Setup-*.exe is missing.
set "CODE=1"
goto :finish

rem NO_TAG=1 exists to commit and push without releasing. It used to fall through to the
rem build and publish steps anyway, and publishing without a tag lets GitHub invent one at
rem whatever the default branch happens to be. Stop after the push instead.
:no_tag
echo.
echo   NO_TAG=1 - committed and pushed. Nothing was tagged, built or published.
echo   Run again without NO_TAG to build the installer and publish the release.
goto :done

:steps_skipped
echo.
echo   ERROR: the commit, push and tag steps did not all run, so this run is not allowed
echo   to build or publish anything.
echo.
echo   cmd.exe mis-executes a batch file with Unix line endings: after a nested batch call
echo   it resumes at the wrong offset and silently skips whole sections. Check this file:
echo     node scripts\check-bat-eol.mjs release.bat
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] steps skipped, refusing to publish
goto :finish

:not_pushed
echo.
echo   ERROR: HEAD is not on origin, so a release built here would not match a commit.
echo   Push it first:  git push origin %BRANCH%
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] HEAD not pushed, refusing to publish
goto :finish

:dirty_tree
echo.
echo   ERROR: the working tree changed after the commit, so the release would not match
echo   what is in git. Run again so it is committed first.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] working tree changed, refusing to publish
goto :finish

:no_tag_ref
echo.
echo   ERROR: the tag v!VERSION! is not on the remote, so publishing now would create a
echo   release against the wrong commit. Refusing to publish.
set "CODE=1"
>>"%LOG%" echo [%DATE% %TIME%] tag v!VERSION! missing, refusing to publish
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

rem Creates the repository or attaches the existing one, so the rest of the script
rem always has an origin to push to and a release to publish into.
:ensure_repo
if "%REPO%"=="" (
    if not exist ".git" goto :no_repo
    goto :ensure_repo_remote
)

rem An origin already means there is a repository to release into - nothing to create.
if exist ".git" (
    git remote get-url origin >nul 2>nul
    if not errorlevel 1 exit /b 0
)

where gh >nul 2>nul
if errorlevel 1 goto :ensure_repo_manual

echo   Repository: creating %REPO% with the GitHub CLI...
call :create_with_gh
if errorlevel 1 (
    echo         gh could not create it - assuming %REPO% already exists.
    call :ensure_repo_manual
    exit /b !errorlevel!
)
>>"%LOG%" echo [%DATE% %TIME%] gh repo create %REPO%
exit /b 0

rem --source needs a local git repository, so a folder that has not been initialised yet
rem falls back to creating the repository on its own and wiring the remote up below.
rem Errors are swallowed because "the repository already exists" is the common case, and
rem that is not a failure - the remote is added either way.
:create_with_gh
if /i "%PUBLIC%"=="1" (
    call gh repo create "%REPO%" --source . --remote origin --public 2>nul
) else (
    call gh repo create "%REPO%" --source . --remote origin --private 2>nul
)
if not errorlevel 1 exit /b 0
if /i "%PUBLIC%"=="1" (
    call gh repo create "%REPO%" --public 2>nul
) else (
    call gh repo create "%REPO%" --private 2>nul
)
if errorlevel 1 exit /b 1
call :ensure_repo_manual
exit /b !errorlevel!

:ensure_repo_manual
if not exist ".git" (
    echo   Repository: initialising a new git repository...
    git init -b main
    if errorlevel 1 (
        echo.
        echo   ERROR: git init failed.
        exit /b 1
    )
)
echo   Repository: adding the origin remote for %REPO%...
git remote remove origin >nul 2>nul
git remote add origin "https://github.com/%REPO%.git"
if errorlevel 1 (
    echo.
    echo   ERROR: could not add the origin remote.
    exit /b 1
)
>>"%LOG%" echo [%DATE% %TIME%] git remote add origin %REPO%
exit /b 0

:ensure_repo_remote
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    if "%REPO%"=="" (
        echo.
        echo   ERROR: this repository has no "origin" remote.
        echo   Add one ^(git remote add origin https://github.com/owner/name.git^)
        echo   or run this script with REPO=owner/name.
        exit /b 1
    )
    call :ensure_repo_manual
    exit /b !errorlevel!
)
exit /b 0

rem Reads owner and repository from the origin remote, so the release goes to the
rem same place the push did.
:resolve_remote
for /f "delims=" %%u in ('git remote get-url origin') do set "REMOTE=%%u"
if "!REMOTE!"=="" goto :no_remote
set "REMOTE=!REMOTE:ssh://git@github.com/=!"
set "REMOTE=!REMOTE:git@github.com:=!"
set "REMOTE=!REMOTE:https://github.com/=!"
set "REMOTE=!REMOTE:http://github.com/=!"
set "REMOTE=!REMOTE:.git=!"
for /f "tokens=1,2 delims=/" %%a in ("!REMOTE!") do (
    set "OWNER=%%a"
    set "REPO_NAME=%%b"
)
if "!OWNER!"=="" goto :no_remote
if "!REPO_NAME!"=="" goto :no_remote
exit /b 0

:no_remote
echo.
echo   ERROR: could not work out the GitHub owner and repository from the origin remote.
echo   Expected something like https://github.com/owner/name.git
exit /b 1

rem electron-builder publishes with GH_TOKEN; a signed-in GitHub CLI already has one,
rem so reuse it instead of making the user copy a token around.
:resolve_token
if not "%GH_TOKEN%"=="" (
    set "TOKEN_STATE=GH_TOKEN from the environment"
    exit /b 0
)
if not "%GITHUB_TOKEN%"=="" (
    set "GH_TOKEN=%GITHUB_TOKEN%"
    set "TOKEN_STATE=GITHUB_TOKEN from the environment"
    exit /b 0
)
where gh >nul 2>nul
if errorlevel 1 goto :no_token
for /f "delims=" %%t in ('gh auth token 2^>nul') do set "GH_TOKEN=%%t"
if "%GH_TOKEN%"=="" goto :no_token
set "TOKEN_STATE=reused from gh auth token"
exit /b 0

:no_token
echo.
echo   ERROR: no GitHub token available to publish with.
echo.
echo   Either set one for this session:
echo     set GH_TOKEN=ghp_your_token_here
echo   or sign in once with the GitHub CLI ^(https://cli.github.com^):
echo     gh auth login
echo.
echo   The token needs "repo" scope so it can create the release and upload assets.
set "CODE=1"
goto :finish

rem VERSION=1.2.3 rewrites package.json before the commit; otherwise the current
rem version is released as-is. Either way the release tag matches package.json.
:resolve_version
if not "%VERSION%"=="" (
    echo   Version   : setting package.json to %VERSION%...
    call npm version %VERSION% --no-git-tag-version --allow-same-version
    if errorlevel 1 (
        echo.
        echo   ERROR: npm version could not set %VERSION%.
        exit /b 1
    )
)
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "VERSION=%%v"
if "!VERSION!"=="" (
    echo.
    echo   ERROR: could not read the version from package.json.
    exit /b 1
)
exit /b 0

:commit
git add -A
if errorlevel 1 (
    echo.
    echo   ERROR: git add failed.
    exit /b 1
)
git diff --cached --quiet
if not errorlevel 1 (
    echo         Nothing to commit - the working tree already matches HEAD.
    exit /b 0
)
echo         Files in this commit:
git diff --cached --stat
if "%COMMIT_MSG%"=="" (
    set "COMMIT_MSG=v!VERSION!: ClipForge release"
)
git commit -m "!COMMIT_MSG!"
if errorlevel 1 (
    echo.
    echo   ERROR: git commit failed. Set COMMIT_MSG to override the message.
    exit /b 1
)
call :mark "committed"
exit /b 0

:tag
git rev-parse -q --verify "refs/tags/v!VERSION!" >nul
if not errorlevel 1 (
    echo.
    echo   ERROR: the tag v!VERSION! already exists, so this version was released before.
    echo   Bump it first:  set VERSION=^(a higher number^)  and run again.
    echo   If the tag was a mistake:  git tag -d v!VERSION!
    >>"%LOG%" echo [%DATE% %TIME%] git tag FAILED, tag exists
    set "CODE=1"
    exit /b 1
)
echo.
echo   Tagging v!VERSION! and pushing it...
git tag "v!VERSION!"
if errorlevel 1 exit /b 1
git push origin "v!VERSION!"
if errorlevel 1 (
    echo.
    echo   ERROR: could not push the tag. Delete it with: git tag -d v!VERSION!
    exit /b 1
)
call :mark "tagged v!VERSION!"
set "DID_TAG=1"
exit /b 0
