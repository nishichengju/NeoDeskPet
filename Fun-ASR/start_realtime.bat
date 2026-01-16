@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 可选：如果你本机存在 ffmpeg，可将其加入 PATH（这里使用相对路径）
set "FFMPEG_DIR=%~dp0..\GPT-SoVITS-v2_ProPlus\ffmpeg"
if exist "%FFMPEG_DIR%\ffmpeg.exe" set "PATH=%FFMPEG_DIR%;%PATH%"

echo Starting Fun-ASR realtime ASR server...
echo Open: http://localhost:8765
echo.

rem 使用系统 python；如需指定解释器，可提前 set PYTHON_EXE=C:\path\to\python.exe
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"
"%PYTHON_EXE%" realtime_server.py
pause
endlocal

