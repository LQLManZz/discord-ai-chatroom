@echo off
rem Keeps AIAgentBot running: restarts it 10s after any crash/exit. The bot itself keeps onWatch alive.
rem Logs: .chatroom\bot.log
cd /d "%~dp0.."
if not exist .chatroom mkdir .chatroom
:loop
echo [%date% %time%] starting bot>> .chatroom\bot.log
node src\index.js >> .chatroom\bot.log 2>&1
echo [%date% %time%] bot exited with code %errorlevel%, restarting in 10s>> .chatroom\bot.log
timeout /t 10 /nobreak >nul
goto loop
