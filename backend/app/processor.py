from __future__ import annotations

import json
import math
import shutil
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

from .chroma import ChromaOptions, apply_chroma_key, parse_hex_color
from .config import MAX_DURATION_SECONDS, MAX_FRAMES
from .exporter import create_gif, create_spine_package, create_sprite_sheet, zip_directory

ProgressCallback = Callable[[float, str], None]


@dataclass
class CropRect:
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0

    def normalized(self, frame_w: int, frame_h: int) -> Optional["CropRect"]:
        x = max(0, min(int(self.x), frame_w - 1))
        y = max(0, min(int(self.y), frame_h - 1))
        w = max(0, min(int(self.w), frame_w - x))
        h = max(0, min(int(self.h), frame_h - y))
        if w <= 1 or h <= 1:
            return None
        return CropRect(x=x, y=y, w=w, h=h)


@dataclass
class ProcessOptions:
    start_time: float = 0.0
    end_time: float = 0.0
    fps: float = 12.0
    max_frames: int = MAX_FRAMES
    remove_background: bool = True
    key_color: str = "#00ff00"
    tolerance: float = 45.0
    softness: float = 18.0
    despill: float = 0.75
    denoise: int = 1
    fill_holes: int = 1
    crop: CropRect = field(default_factory=CropRect)
    resize_width: int = 0
    resize_height: int = 0
    sheet_columns: int = 6
    sheet_gap: int = 0
    spine_animation: str = "idle"


def probe_video(path: Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("无法打开视频。请确认视频格式受 OpenCV/FFmpeg 支持。")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = frame_count / fps if fps > 0 and frame_count > 0 else 0
    cap.release()
    return {
        "fps": fps,
        "frame_count": frame_count,
        "width": width,
        "height": height,
        "duration": duration,
    }


def _sanitize_options(options: ProcessOptions, video_info: dict) -> ProcessOptions:
    duration = float(video_info.get("duration") or 0)
    start = max(0.0, float(options.start_time or 0))
    end = float(options.end_time or 0)
    if end <= 0 or (duration > 0 and end > duration):
        end = duration
    if duration <= 0:
        end = max(end, start + min(MAX_DURATION_SECONDS, 10.0))
    if end <= start:
        end = min(start + 1.0, duration or start + 1.0)

    end = min(end, start + MAX_DURATION_SECONDS)
    fps = float(options.fps or 12)
    fps = max(1.0, min(fps, 30.0))
    max_frames = max(1, min(int(options.max_frames or MAX_FRAMES), MAX_FRAMES))

    rw = max(0, int(options.resize_width or 0))
    rh = max(0, int(options.resize_height or 0))

    return ProcessOptions(
        start_time=start,
        end_time=end,
        fps=fps,
        max_frames=max_frames,
        remove_background=bool(options.remove_background),
        key_color=options.key_color,
        tolerance=float(options.tolerance),
        softness=float(options.softness),
        despill=float(options.despill),
        denoise=max(0, min(int(options.denoise), 5)),
        fill_holes=max(0, min(int(options.fill_holes), 5)),
        crop=options.crop,
        resize_width=rw,
        resize_height=rh,
        sheet_columns=max(1, min(int(options.sheet_columns or 6), 24)),
        sheet_gap=max(0, min(int(getattr(options, "sheet_gap", 0) or 0), 64)),
        spine_animation=(getattr(options, "spine_animation", "idle") or "idle")[:60],
    )


def _frame_times(start: float, end: float, fps: float, max_frames: int) -> List[float]:
    if end <= start:
        return [start]
    total = int(math.floor((end - start) * fps)) + 1
    total = max(1, min(total, max_frames))
    return [start + i / fps for i in range(total)]


def _resize_frame(frame: np.ndarray, width: int, height: int) -> np.ndarray:
    if width <= 0 and height <= 0:
        return frame
    h, w = frame.shape[:2]
    channels = frame.shape[2]
    if width > 0 and height > 0:
        target = (width, height)
    elif width > 0:
        target = (width, max(1, round(h * (width / w))))
    else:
        target = (max(1, round(w * (height / h))), height)
    return cv2.resize(frame, target, interpolation=cv2.INTER_AREA if target[0] < w or target[1] < h else cv2.INTER_CUBIC)


def process_video(input_path: Path, job_dir: Path, options: ProcessOptions, progress: ProgressCallback) -> dict:
    start_clock = time.time()
    input_path = Path(input_path)
    job_dir = Path(job_dir)
    frames_dir = job_dir / "frames"
    outputs_dir = job_dir / "outputs"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    if outputs_dir.exists():
        shutil.rmtree(outputs_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)

    progress(0.02, "读取视频信息")
    info = probe_video(input_path)
    options = _sanitize_options(options, info)
    times = _frame_times(options.start_time, options.end_time, options.fps, options.max_frames)
    if not times:
        raise ValueError("没有可处理的帧，请调整起止时间或 FPS")

    progress(0.05, f"开始逐帧处理，共 {len(times)} 帧")
    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise ValueError("无法打开视频")

    chroma_options = ChromaOptions(
        key_color=parse_hex_color(options.key_color),
        tolerance=options.tolerance,
        softness=options.softness,
        despill=options.despill,
        denoise=options.denoise,
        fill_holes=options.fill_holes,
    )

    frame_paths: List[Path] = []
    first_size: Tuple[int, int] | None = None

    try:
        for index, ts in enumerate(times):
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, ts) * 1000.0)
            ok, frame_bgr = cap.read()
            if not ok or frame_bgr is None:
                continue

            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            crop = options.crop.normalized(frame_rgb.shape[1], frame_rgb.shape[0])
            if crop:
                frame_rgb = frame_rgb[crop.y: crop.y + crop.h, crop.x: crop.x + crop.w]

            frame_rgb = _resize_frame(frame_rgb, options.resize_width, options.resize_height)

            if options.remove_background:
                frame_out = apply_chroma_key(frame_rgb, chroma_options)
                mode = "RGBA"
            else:
                frame_out = frame_rgb
                mode = "RGB"

            frame_path = frames_dir / f"frame_{len(frame_paths):04d}.png"
            Image.fromarray(frame_out, mode=mode).save(frame_path)
            frame_paths.append(frame_path)
            if first_size is None:
                first_size = (frame_out.shape[1], frame_out.shape[0])

            progress(0.05 + 0.65 * ((index + 1) / len(times)), f"已处理 {index + 1}/{len(times)} 帧")
    finally:
        cap.release()

    if not frame_paths:
        raise ValueError("未能成功提取任何帧，请检查视频编码或时间范围")

    progress(0.73, "打包单帧 PNG")
    frames_zip = outputs_dir / "frames.zip"
    zip_directory(frames_dir, frames_zip)

    progress(0.80, "生成精灵图")
    sheet_info = create_sprite_sheet(frame_paths, outputs_dir / "sprite_sheet.png", columns=options.sheet_columns, gap=options.sheet_gap)

    gif_info = None
    try:
        progress(0.88, "生成 GIF")
        gif_info = create_gif(frame_paths, outputs_dir / "animation.gif", fps=options.fps)
    except Exception as exc:
        gif_info = {"error": str(exc)}

    progress(0.94, "生成 Spine 基础包")
    spine_info = create_spine_package(frame_paths, outputs_dir / "spine.zip", fps=options.fps, animation_name=options.spine_animation)

    report = {
        "video": info,
        "options": {
            **asdict(options),
            "crop": asdict(options.crop),
        },
        "frames": {
            "count": len(frame_paths),
            "size": {"width": first_size[0], "height": first_size[1]} if first_size else None,
        },
        "exports": {
            "frames_zip": "frames.zip",
            "sprite_sheet": sheet_info,
            "gif": gif_info,
            "spine": spine_info,
        },
        "elapsed_seconds": round(time.time() - start_clock, 3),
    }

    (outputs_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    progress(1.0, "处理完成")
    return report
