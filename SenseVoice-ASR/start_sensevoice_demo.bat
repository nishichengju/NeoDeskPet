@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 将 ModelScope 的缓存放到项目目录，避免下载到用户目录（可选）
set "MODELSCOPE_CACHE=%~dp0..\GPT-SoVITS-v2_ProPlus\SenseVoiceSmall"

echo Starting SenseVoiceSmall ASR demo...
echo Open: http://127.0.0.1:8766
echo.

rem 使用系统 python；如需指定解释器，可提前 set PYTHON_EXE=C:\path\to\python.exe
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"
"%PYTHON_EXE%" sensevoice_server.py
pause
endlocal

