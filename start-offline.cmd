@echo off
setlocal
cd /d "%~dp0"
echo [offline] 启动 AI 漫剧电影工厂（自带 ffmpeg + 本地 PNG 出图）
echo [offline] 界面地址： http://127.0.0.1:8788/
echo.
node scripts\start-offline.mjs
if errorlevel 1 (
  echo.
  echo [offline] 启动失败，请把上面的错误信息发给开发。
)
pause
