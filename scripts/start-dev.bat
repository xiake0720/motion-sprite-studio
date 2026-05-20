@echo off
setlocal
cd /d %~dp0\..

cd backend
if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate
pip install -r requirements.txt
start "game-asset-backend" cmd /k "uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --log-level debug"

cd ..\frontend
npm install
npm run dev
