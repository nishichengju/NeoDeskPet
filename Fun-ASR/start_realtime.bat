@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "PATH=G:\DeskPet\NeoDeskPet-electron\GPT-SoVITS-v2_ProPlus\ffmpeg;%PATH%"

echo Starting Fun-ASR realtime ASR server...
echo Open: http://localhost:8765
echo.

G:\DeskPet\NeoDeskPet\voxcpm-rainfall\python\python.exe realtime_server.py
pause
endlocal

