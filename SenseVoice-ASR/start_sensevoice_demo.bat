@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 可选：将 ModelScope 缓存放到项目目录
set "MODELSCOPE_CACHE=%~dp0..\GPT-SoVITS-v2_ProPlus\SenseVoiceSmall"

echo Starting SenseVoiceSmall ASR demo...
echo Open: http://127.0.0.1:8766
echo.

rem 可选：先指定解释器，例如 set PYTHON_EXE=C:\path\to\python.exe
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"
"%PYTHON_EXE%" -c "import torch; print('[SenseVoice] torch:', getattr(torch,'__version__','?'), 'cuda_available:', bool(getattr(torch,'cuda',None) and torch.cuda.is_available()), 'torch.version.cuda:', getattr(getattr(torch,'version',None),'cuda',None))" 2>nul
"%PYTHON_EXE%" sensevoice_server.py
pause
endlocal
