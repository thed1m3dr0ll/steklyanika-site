@echo off
chcp 65001 >nul
cd /d "%~dp0site"
if not exist node_modules call npm install
if not exist node_modules\decap-server call npm install
rem Сервер админки (для http://localhost:4321/admin/) запускается в отдельном свёрнутом окне
start "Стекляника — сервер админки" /min cmd /c npm run cms
start "" http://localhost:4321
call npm run dev
pause
