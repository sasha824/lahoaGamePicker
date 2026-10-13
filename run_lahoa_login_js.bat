@echo off
cd /d "%~dp0"
node lahoa_login.js --auto >> lahoa_log.txt 2>&1
