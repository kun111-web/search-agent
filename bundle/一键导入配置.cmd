@echo off
rem Keep this file pure ASCII: cmd reads .cmd as ANSI, so Chinese text inside
rem would arrive at PowerShell mangled. All the Chinese lives in the .ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-config.ps1"
