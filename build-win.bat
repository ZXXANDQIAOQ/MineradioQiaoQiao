@echo off
setlocal
chcp 65001 >nul
title Build Mineradio

rem ============================================================
rem  Mineradio 一键打包（Windows / x64）
rem
rem  双击本文件即可。产物在工程目录的 dist\ 里：
rem    dist\win-unpacked\Mineradio.exe   免安装绿色版，双击直接跑
rem    dist\Mineradio-<版本>-Setup.exe   安装包
rem
rem  下载慢或卡住不用慌：npm 脚本里已经走 npmmirror 镜像，
rem  见 scripts/electron-builder-run.js。
rem ============================================================

rem 用法：
rem   build-win.bat          两个都出（绿色版 + 安装包）
rem   build-win.bat dir      只出免安装绿色版（最快，约 2 分钟）
rem   build-win.bat setup    只出安装包

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=all"

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%" || goto :fail

if not exist "node_modules\electron\dist\electron.exe" (
  echo [i] 没找到 Electron，先装依赖...
  call npm install || goto :fail
)

if /i "%TARGET%"=="dir"   goto :dir
if /i "%TARGET%"=="setup" goto :setup

echo.
echo === 1/2 免安装绿色版 ===
call npm run build:win:dir || goto :fail
echo.
echo === 2/2 NSIS 安装包 ===
call npm run build:win || goto :fail
goto :done

:dir
echo.
echo === 免安装绿色版 ===
call npm run build:win:dir || goto :fail
goto :done

:setup
echo.
echo === NSIS 安装包 ===
call npm run build:win || goto :fail
goto :done

:done
echo.
echo 构建完成，产物在 dist\ 里：
dir /b "dist\Mineradio*.exe" 2>nul
echo.
pause
exit /b 0

:fail
echo.
echo [FAIL] 构建没成功，把上面的报错发出来即可。
echo.
pause
exit /b 1
