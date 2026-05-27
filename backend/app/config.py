from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]

DATA_DIR = Path(os.getenv("VTS_DATA_DIR", str(BASE_DIR / "data"))).resolve()
UPLOAD_DIR = DATA_DIR / "uploads"
JOB_DIR = DATA_DIR / "jobs"

MAX_UPLOAD_MB = int(os.getenv("VTS_MAX_UPLOAD_MB", "200"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_DURATION_SECONDS = float(os.getenv("VTS_MAX_DURATION_SECONDS", "60"))
MAX_FRAMES = int(os.getenv("VTS_MAX_FRAMES", "120"))
TASK_WORKERS = int(os.getenv("VTS_WORKERS", "1"))
KEEP_ORIGINAL_UPLOAD_NAME = os.getenv("VTS_KEEP_UPLOAD_NAME", "0") == "1"

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}

for p in (DATA_DIR, UPLOAD_DIR, JOB_DIR):
    p.mkdir(parents=True, exist_ok=True)
