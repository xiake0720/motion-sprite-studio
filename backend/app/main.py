from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import ALLOWED_EXTENSIONS, JOB_DIR, MAX_FRAMES, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, UPLOAD_DIR
from .jobs import manager
from .processor import CropRect, ProcessOptions
from .image_tools import IMAGE_ALLOWED, ImageCutoutOptions, safe_name as safe_image_name, run_image_cutout
from .audio_tools import run_audio_generate

app = FastAPI(title="Game Asset Studio", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _safe_filename(name: str) -> str:
    name = Path(name or "video.mp4").name
    name = re.sub(r"[^a-zA-Z0-9._\-\u4e00-\u9fff]", "_", name)
    return name[:120] or "video.mp4"


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "game-asset-studio"}


@app.get("/api/config")
def get_config() -> dict:
    return {
        "max_upload_mb": MAX_UPLOAD_MB,
        "max_frames": MAX_FRAMES,
        "allowed_extensions": sorted(ALLOWED_EXTENSIONS),
    }


@app.post("/api/jobs")
async def create_job(
    file: UploadFile = File(...),
    start_time: float = Form(0.0),
    end_time: float = Form(0.0),
    fps: float = Form(12.0),
    max_frames: int = Form(MAX_FRAMES),
    remove_background: bool = Form(True),
    key_color: str = Form("#00ff00"),
    tolerance: float = Form(45.0),
    softness: float = Form(18.0),
    despill: float = Form(0.75),
    denoise: int = Form(1),
    fill_holes: int = Form(1),
    crop_x: int = Form(0),
    crop_y: int = Form(0),
    crop_w: int = Form(0),
    crop_h: int = Form(0),
    resize_width: int = Form(0),
    resize_height: int = Form(0),
    sheet_columns: int = Form(6),
    sheet_gap: int = Form(0),
    spine_animation: str = Form("idle"),
):
    original_name = _safe_filename(file.filename or "video.mp4")
    ext = Path(original_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"不支持的视频格式：{ext}，支持：{', '.join(sorted(ALLOWED_EXTENSIONS))}")

    temp_id = os.urandom(8).hex()
    upload_path = UPLOAD_DIR / f"{temp_id}_{original_name}"
    total = 0
    try:
        with upload_path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"文件超过限制：{MAX_UPLOAD_MB}MB")
                out.write(chunk)
    except Exception:
        if upload_path.exists():
            upload_path.unlink(missing_ok=True)
        raise

    options = ProcessOptions(
        start_time=start_time,
        end_time=end_time,
        fps=fps,
        max_frames=max_frames,
        remove_background=remove_background,
        key_color=key_color,
        tolerance=tolerance,
        softness=softness,
        despill=despill,
        denoise=denoise,
        fill_holes=fill_holes,
        crop=CropRect(crop_x, crop_y, crop_w, crop_h),
        resize_width=resize_width,
        resize_height=resize_height,
        sheet_columns=sheet_columns,
        sheet_gap=sheet_gap,
        spine_animation=spine_animation,
    )
    state = manager.create_job(upload_path, original_name, options)
    return state.to_dict()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    state = manager.get(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="任务不存在")
    return state.to_dict()


@app.get("/api/jobs/{job_id}/download/{filename}")
def download(job_id: str, filename: str):
    filename = Path(filename).name
    allowed = {"frames.zip", "sprite_sheet.png", "animation.gif", "spine.zip", "report.json"}
    if filename not in allowed:
        raise HTTPException(status_code=404, detail="文件不存在")
    path = JOB_DIR / job_id / "outputs" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path, filename=filename)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job_dir = JOB_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="任务不存在")
    shutil.rmtree(job_dir, ignore_errors=True)
    return {"ok": True}


@app.post("/api/image/cutout")
async def image_cutout(
    files: list[UploadFile] = File(...),
    mode: str = Form("auto"),
    key_color: str = Form("#ffffff"),
    tolerance: float = Form(34.0),
    softness: float = Form(5.0),
    erode: int = Form(1),
    dilate: int = Form(0),
    edge_protect: bool = Form(True),
    decontaminate: float = Form(0.85),
    close_gaps: int = Form(1),
    trim: bool = Form(True),
    split_assets: bool = Form(True),
    min_area: int = Form(160),
    padding: int = Form(6),
    output_format: str = Form("png"),
    sheet_columns: int = Form(6),
    sheet_gap: int = Form(8),
    sample_points: str = Form("[]"),
    erase_points: str = Form("[]"),
    keep_points: str = Form("[]"),
    sample_radius: int = Form(3),
    erase_radius: int = Form(28),
    keep_radius: int = Form(28),
    manual_strength: float = Form(1.0),
):
    if not files:
        raise HTTPException(status_code=400, detail="请上传图片")
    temp_id = os.urandom(8).hex()
    upload_root = UPLOAD_DIR / "images" / temp_id
    upload_root.mkdir(parents=True, exist_ok=True)
    uploaded: list[tuple[str, Path]] = []
    total = 0
    try:
        for item in files[:80]:
            original_name = safe_image_name(item.filename or "image.png")
            ext = Path(original_name).suffix.lower()
            if ext not in IMAGE_ALLOWED:
                raise HTTPException(status_code=400, detail=f"不支持的图片格式：{ext}")
            path = upload_root / f"{len(uploaded)+1:03d}_{original_name}"
            with path.open("wb") as out:
                while True:
                    chunk = await item.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail=f"图片总大小超过限制：{MAX_UPLOAD_MB}MB")
                    out.write(chunk)
            uploaded.append((original_name, path))
        options = ImageCutoutOptions(
            mode=mode,
            key_color=key_color,
            tolerance=tolerance,
            softness=softness,
            erode=erode,
            dilate=dilate,
            edge_protect=edge_protect,
            decontaminate=decontaminate,
            close_gaps=close_gaps,
            trim=trim,
            split_assets=split_assets,
            min_area=min_area,
            padding=padding,
            output_format=output_format,
            sheet_columns=sheet_columns,
            sheet_gap=sheet_gap,
            sample_points=sample_points,
            erase_points=erase_points,
            keep_points=keep_points,
            sample_radius=sample_radius,
            erase_radius=erase_radius,
            keep_radius=keep_radius,
            manual_strength=manual_strength,
        )
        return run_image_cutout(uploaded, options)
    finally:
        shutil.rmtree(upload_root, ignore_errors=True)


@app.get("/api/image/results/{result_id}/{file_path:path}")
def image_result(result_id: str, file_path: str):
    safe_id = Path(result_id).name
    target = (JOB_DIR / "image" / safe_id / "outputs" / file_path).resolve()
    base = (JOB_DIR / "image" / safe_id / "outputs").resolve()
    if not str(target).startswith(str(base)) or not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(target, filename=target.name)


@app.post("/api/audio/generate")
def audio_generate(payload: dict = Body(...)):
    try:
        return run_audio_generate(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/audio/results/{result_id}/{file_path:path}")
def audio_result(result_id: str, file_path: str):
    safe_id = Path(result_id).name
    target = (JOB_DIR / "audio" / safe_id / "outputs" / file_path).resolve()
    base = (JOB_DIR / "audio" / safe_id / "outputs").resolve()
    if not str(target).startswith(str(base)) or not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(target, filename=target.name)


# Serve built Vite frontend from Docker/production image.
DIST_DIR = Path(__file__).resolve().parents[2] / "frontend_dist"
if DIST_DIR.exists():
    assets = DIST_DIR / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        target = DIST_DIR / full_path
        if target.exists() and target.is_file():
            return FileResponse(target)
        return FileResponse(DIST_DIR / "index.html")
