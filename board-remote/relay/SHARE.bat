@echo off
title HCI ONE Remote, link for your phone
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0share.ps1"
pause
