from __future__ import annotations

import json
import os
import re
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
from PIL import Image

from .config import JOB_DIR

IMAGE_ALLOWED = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}


def safe_name(name: str, default: str = 'image.png') -> str:
    name = Path(name or default).name
    name = re.sub(r'[^a-zA-Z0-9._\-\u4e00-\u9fff]', '_', name)
    return name[:120] or default


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    clean = (value or '#ffffff').replace('#', '').strip()
    if len(clean) == 3:
        clean = ''.join(c + c for c in clean)
    clean = (clean + '000000')[:6]
    try:
        n = int(clean, 16)
    except ValueError:
        n = 0xFFFFFF
    return (n >> 16 & 255, n >> 8 & 255, n & 255)


def detect_border_color(rgb: np.ndarray) -> tuple[int, int, int]:
    h, w = rgb.shape[:2]
    band = max(2, min(16, h // 20 or 2, w // 20 or 2))
    border = np.concatenate([
        rgb[:band, :, :].reshape(-1, 3),
        rgb[-band:, :, :].reshape(-1, 3),
        rgb[:, :band, :].reshape(-1, 3),
        rgb[:, -band:, :].reshape(-1, 3),
    ], axis=0)
    # Quantize border colors to reduce JPEG noise and choose dominant color.
    q = (border // 8) * 8
    colors, counts = np.unique(q, axis=0, return_counts=True)
    color = colors[int(np.argmax(counts))]
    return tuple(int(v) for v in color)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    if edge1 <= edge0:
        return (x >= edge0).astype(np.float32)
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)



def parse_point_json(value: str | None) -> list[dict]:
    """Parse frontend point annotations.

    Points use source-image pixel coordinates. Supported shapes:
    {"x": 120, "y": 80}, {"x": 120, "y": 80, "radius": 32}.
    Invalid entries are ignored instead of failing the whole job so users can
    iterate quickly while tuning a cutout.
    """
    if not value:
        return []
    try:
        data = json.loads(value)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data[:300]:
        if not isinstance(item, dict):
            continue
        try:
            x = float(item.get('x', 0))
            y = float(item.get('y', 0))
        except Exception:
            continue
        point = {'x': x, 'y': y}
        for key in ('radius', 'kind'):
            if key in item:
                point[key] = item[key]
        out.append(point)
    return out


def clamp_point(point: dict, w: int, h: int) -> tuple[int, int] | None:
    try:
        x = int(round(float(point.get('x', 0))))
        y = int(round(float(point.get('y', 0))))
    except Exception:
        return None
    if x < 0 or y < 0 or x >= w or y >= h:
        return None
    return x, y


def point_colors(rgb_u8: np.ndarray, points: list[dict], radius: int = 2) -> list[tuple[int, int, int]]:
    """Sample robust median colors around user points."""
    h, w = rgb_u8.shape[:2]
    colors: list[tuple[int, int, int]] = []
    radius = max(0, min(int(radius or 0), 24))
    for point in points:
        xy = clamp_point(point, w, h)
        if not xy:
            continue
        x, y = xy
        x0, x1 = max(0, x - radius), min(w, x + radius + 1)
        y0, y1 = max(0, y - radius), min(h, y + radius + 1)
        patch = rgb_u8[y0:y1, x0:x1].reshape(-1, 3)
        if patch.size:
            med = np.median(patch, axis=0)
            colors.append(tuple(int(v) for v in med))
    # de-duplicate nearby samples to keep memory bounded
    uniq: list[tuple[int, int, int]] = []
    for c in colors:
        if not any(sum((c[i] - u[i]) ** 2 for i in range(3)) < 36 for u in uniq):
            uniq.append(c)
    return uniq[:64]


def min_color_distance(rgb: np.ndarray, keys: list[tuple[int, int, int]]) -> np.ndarray:
    if not keys:
        return np.full(rgb.shape[:2], 255.0, dtype=np.float32)
    dist = np.full(rgb.shape[:2], np.inf, dtype=np.float32)
    norm = np.sqrt(3.0)
    for key in keys[:80]:
        key_arr = np.array(key, dtype=np.float32).reshape(1, 1, 3)
        d = np.sqrt(np.sum((rgb - key_arr) ** 2, axis=2)) / norm
        dist = np.minimum(dist, d.astype(np.float32))
    return dist


def circles_mask(shape: tuple[int, int], points: list[dict], default_radius: int) -> np.ndarray:
    h, w = shape
    out = np.zeros((h, w), dtype=np.uint8)
    default_radius = max(1, min(int(default_radius or 1), 260))
    for point in points:
        xy = clamp_point(point, w, h)
        if not xy:
            continue
        r = int(point.get('radius', default_radius) or default_radius)
        r = max(1, min(r, 260))
        cv2.circle(out, xy, r, 255, thickness=-1, lineType=cv2.LINE_AA)
    return out.astype(bool)


def local_flood_masks(rgb: np.ndarray, points: list[dict], tolerance: float, softness: float, radius: int, sample_radius: int = 2) -> np.ndarray:
    """Return local regions selected for removal by user erase points.

    Each erase point samples its local color, builds a local color-similar mask,
    then keeps only the connected component containing the point. This gives a
    more precise "指定扣这里" behavior than a hard circular eraser.
    """
    h, w = rgb.shape[:2]
    out = np.zeros((h, w), dtype=np.uint8)
    rgb_u8 = np.clip(rgb, 0, 255).astype(np.uint8)
    radius = max(6, min(int(radius or 24), 360))
    limit = max(0.0, float(tolerance) + float(softness))
    for point in points:
        xy = clamp_point(point, w, h)
        if not xy:
            continue
        x, y = xy
        key_list = point_colors(rgb_u8, [point], sample_radius)
        if not key_list:
            continue
        x0, x1 = max(0, x - radius), min(w, x + radius + 1)
        y0, y1 = max(0, y - radius), min(h, y + radius + 1)
        patch = rgb[y0:y1, x0:x1]
        dist = min_color_distance(patch, key_list)
        candidate = (dist <= limit).astype(np.uint8)
        local_x, local_y = x - x0, y - y0
        if local_y < 0 or local_x < 0 or local_y >= candidate.shape[0] or local_x >= candidate.shape[1]:
            continue
        count, labels = cv2.connectedComponents(candidate, connectivity=8)
        label = int(labels[local_y, local_x]) if count > 1 else 0
        if label > 0:
            local = (labels == label).astype(np.uint8) * 255
        else:
            local = np.zeros_like(candidate, dtype=np.uint8)
            cv2.circle(local, (local_x, local_y), max(2, radius // 6), 255, thickness=-1, lineType=cv2.LINE_AA)
        out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], local)
    return out.astype(bool)

def trim_alpha(img: Image.Image, padding: int = 0) -> Image.Image:
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    alpha = np.array(img.getchannel('A'))
    ys, xs = np.where(alpha > 3)
    if not len(xs):
        return img
    x0 = max(0, int(xs.min()) - padding)
    y0 = max(0, int(ys.min()) - padding)
    x1 = min(img.width, int(xs.max()) + padding + 1)
    y1 = min(img.height, int(ys.max()) + padding + 1)
    return img.crop((x0, y0, x1, y1))


@dataclass
class ImageCutoutOptions:
    mode: str = 'auto'
    key_color: str = '#ffffff'
    tolerance: float = 34.0
    softness: float = 5.0
    erode: int = 1
    dilate: int = 0
    edge_protect: bool = True
    decontaminate: float = 0.85
    close_gaps: int = 1
    trim: bool = True
    split_assets: bool = True
    min_area: int = 160
    padding: int = 6
    output_format: str = 'png'
    sheet_columns: int = 6
    sheet_gap: int = 8
    sample_points: str = '[]'
    erase_points: str = '[]'
    keep_points: str = '[]'
    sample_radius: int = 3
    erase_radius: int = 28
    keep_radius: int = 28
    manual_strength: float = 1.0


def border_connected_mask(mask: np.ndarray) -> np.ndarray:
    """Return only the True areas that are connected to the image border.

    This protects foreground details that happen to have the same color as the
    background. For character/UI cutouts this is usually closer to visual
    expectations than a global color key, because white eyes, highlights and
    clothing details will no longer be punched out accidentally.
    """
    if mask.dtype != np.uint8:
        mask = mask.astype(np.uint8)
    count, labels = cv2.connectedComponents(mask, connectivity=8)
    if count <= 1:
        return mask.astype(bool)
    border_labels = set(np.unique(labels[0, :]).tolist())
    border_labels.update(np.unique(labels[-1, :]).tolist())
    border_labels.update(np.unique(labels[:, 0]).tolist())
    border_labels.update(np.unique(labels[:, -1]).tolist())
    border_labels.discard(0)
    if not border_labels:
        return np.zeros_like(mask, dtype=bool)
    connected = np.isin(labels, list(border_labels))
    return connected


def alpha_decontaminate(rgb: np.ndarray, alpha: np.ndarray, key: tuple[int, int, int], strength: float) -> np.ndarray:
    """Remove white/green/colored fringe by estimating the foreground color.

    The formula is a practical alpha decontamination step:
    observed = foreground * alpha + key_color * (1-alpha)
    foreground ~= (observed - key * (1-alpha)) / alpha
    """
    strength = max(0.0, min(float(strength), 1.0))
    if strength <= 0:
        return rgb
    a = alpha.astype(np.float32) / 255.0
    edge = (a > 0.02) & (a < 0.98)
    if not np.any(edge):
        return rgb
    key_arr = np.array(key, dtype=np.float32).reshape(1, 1, 3)
    denom = np.maximum(a[:, :, None], 0.05)
    estimated = (rgb.astype(np.float32) - key_arr * (1.0 - a[:, :, None])) / denom
    blended = rgb.astype(np.float32) * (1.0 - strength) + estimated * strength
    out = rgb.astype(np.float32).copy()
    out[edge] = blended[edge]
    return np.clip(out, 0, 255).astype(np.uint8)


def cutout_image(image: Image.Image, options: ImageCutoutOptions) -> tuple[Image.Image, Image.Image, dict]:
    image = image.convert('RGBA')
    arr = np.array(image)
    rgb_u8 = arr[:, :, :3].copy()
    rgb = rgb_u8.astype(np.float32)
    existing_alpha = arr[:, :, 3]
    h, w = rgb.shape[:2]

    sample_points = parse_point_json(options.sample_points)
    erase_points = parse_point_json(options.erase_points)
    keep_points = parse_point_json(options.keep_points)

    mode = (options.mode or 'auto').lower()
    key = None
    keys: list[tuple[int, int, int]] = []
    connected_pixels = 0
    manual_removed_pixels = 0
    protected_pixels = 0

    if mode == 'alpha':
        alpha = existing_alpha.astype(np.uint8)
    else:
        if mode == 'white':
            key = (255, 255, 255)
            keys.append(key)
        elif mode == 'black':
            key = (0, 0, 0)
            keys.append(key)
        elif mode == 'color':
            key = hex_to_rgb(options.key_color)
            keys.append(key)
        elif mode == 'samples':
            key = None
        else:
            key = detect_border_color(arr[:, :, :3])
            keys.append(key)

        sampled = point_colors(rgb_u8, sample_points, options.sample_radius)
        keys.extend(sampled)
        if not keys:
            key = detect_border_color(arr[:, :, :3])
            keys.append(key)
        if key is None and keys:
            key = keys[0]

        dist = min_color_distance(rgb, keys)
        tolerance = max(0.0, float(options.tolerance))
        softness = max(0.1, float(options.softness))
        bg_candidate = (dist <= tolerance + softness).astype(np.uint8)

        kernel = np.ones((3, 3), np.uint8)
        if options.close_gaps > 0:
            bg_candidate = cv2.morphologyEx(bg_candidate, cv2.MORPH_CLOSE, kernel, iterations=min(int(options.close_gaps), 6))

        if options.edge_protect:
            removable_bg = border_connected_mask(bg_candidate)
        else:
            removable_bg = bg_candidate.astype(bool)

        # Manual erase points add local, connected regions that may not touch the
        # canvas border, which solves hair gaps, holes between limbs and other
        # details that color-key methods often miss.
        manual_remove = local_flood_masks(
            rgb,
            erase_points,
            tolerance=tolerance,
            softness=softness,
            radius=max(4, int(options.erase_radius)),
            sample_radius=max(0, int(options.sample_radius)),
        )
        manual_remove = manual_remove | circles_mask((h, w), [p for p in erase_points if str(p.get('kind', '')).lower() == 'brush'], max(2, int(options.erase_radius)))
        removable_bg = removable_bg | manual_remove
        connected_pixels = int(np.count_nonzero(removable_bg))
        manual_removed_pixels = int(np.count_nonzero(manual_remove))

        protect_mask = circles_mask((h, w), keep_points, max(2, int(options.keep_radius)))
        if np.any(protect_mask):
            removable_bg[protect_mask] = False
            protected_pixels = int(np.count_nonzero(protect_mask))

        alpha_float = np.ones(dist.shape, dtype=np.float32)
        removable_alpha = smoothstep(tolerance, tolerance + softness, dist)
        alpha_float[removable_bg] = removable_alpha[removable_bg]
        alpha = np.clip(alpha_float * 255, 0, 255).astype(np.uint8)
        alpha = np.minimum(alpha, existing_alpha)

        # Manual erase is intentionally stronger than automatic background
        # removal. Keep points override it afterwards.
        if np.any(manual_remove):
            strength = max(0.0, min(float(options.manual_strength), 1.0))
            alpha[manual_remove] = np.minimum(alpha[manual_remove], int(255 * (1.0 - strength)))
        if np.any(protect_mask):
            alpha[protect_mask] = np.maximum(alpha[protect_mask], existing_alpha[protect_mask])

        # Edge refinement. Keep the default conservative; users can increase
        # shrink/expand in the UI after checking the preview.
        if options.erode > 0:
            alpha = cv2.erode(alpha, kernel, iterations=min(int(options.erode), 8))
        if options.dilate > 0:
            alpha = cv2.dilate(alpha, kernel, iterations=min(int(options.dilate), 8))
        if options.softness > 0:
            radius = max(1, min(18, int(round(options.softness))))
            k = radius * 2 + 1
            alpha = cv2.GaussianBlur(alpha, (k, k), 0)
            if np.any(protect_mask):
                alpha[protect_mask] = np.maximum(alpha[protect_mask], existing_alpha[protect_mask])

        if key is not None:
            arr[:, :, :3] = alpha_decontaminate(arr[:, :, :3], alpha, key, float(options.decontaminate))

            dominant = int(np.argmax(key))
            if max(key) - min(key) > 60:
                edge_weight = (1.0 - alpha.astype(np.float32) / 255.0)
                out_rgb = arr[:, :, :3].astype(np.float32)
                other = np.max(np.delete(out_rgb, dominant, axis=2), axis=2)
                excess = np.maximum(0, out_rgb[:, :, dominant] - other)
                out_rgb[:, :, dominant] -= excess * edge_weight * max(0.0, min(1.0, float(options.decontaminate)))
                arr[:, :, :3] = np.clip(out_rgb, 0, 255).astype(np.uint8)

    arr[:, :, 3] = alpha
    out = Image.fromarray(arr, 'RGBA')
    if options.trim:
        out = trim_alpha(out, options.padding)
    alpha_img = Image.fromarray(alpha, 'L')
    report = {
        'mode': mode,
        'detected_key_color': key if mode != 'alpha' else None,
        'sampled_key_colors': keys,
        'sample_points': len(sample_points),
        'erase_points': len(erase_points),
        'keep_points': len(keep_points),
        'edge_protect': bool(options.edge_protect),
        'connected_background_pixels': connected_pixels,
        'manual_removed_pixels': manual_removed_pixels,
        'protected_pixels': protected_pixels,
        'decontaminate': float(options.decontaminate),
        'original_size': [image.width, image.height],
        'output_size': [out.width, out.height],
    }
    return out, alpha_img, report

def detect_regions(img: Image.Image, options: ImageCutoutOptions) -> list[dict]:
    rgba = np.array(img.convert('RGBA'))
    alpha = rgba[:, :, 3]
    mask = (alpha > 12).astype(np.uint8) * 255
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    regions: list[dict] = []
    for idx in range(1, count):
        x, y, w, h, area = stats[idx]
        if int(area) < max(1, int(options.min_area)):
            continue
        pad = max(0, int(options.padding))
        x0 = max(0, int(x) - pad)
        y0 = max(0, int(y) - pad)
        x1 = min(img.width, int(x + w) + pad)
        y1 = min(img.height, int(y + h) + pad)
        regions.append({'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0, 'area': int(area)})
    regions.sort(key=lambda r: (r['y'], r['x']))
    return regions


def build_sheet(images: list[Image.Image], columns: int, gap: int) -> Image.Image | None:
    if not images:
        return None
    columns = max(1, min(int(columns or 1), 24))
    gap = max(0, min(int(gap or 0), 64))
    cell_w = max(im.width for im in images)
    cell_h = max(im.height for im in images)
    rows = int(np.ceil(len(images) / columns))
    sheet = Image.new('RGBA', (columns * cell_w + gap * (columns - 1), rows * cell_h + gap * (rows - 1)), (0, 0, 0, 0))
    for i, im in enumerate(images):
        x = (i % columns) * (cell_w + gap)
        y = (i // columns) * (cell_h + gap)
        sheet.alpha_composite(im, (x, y))
    return sheet


def save_transparent(img: Image.Image, path: Path, fmt: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fmt.lower() == 'webp':
        img.save(path, format='WEBP', lossless=True, quality=100)
    else:
        img.save(path, format='PNG')


def run_image_cutout(uploaded: Iterable[tuple[str, Path]], options: ImageCutoutOptions) -> dict:
    result_id = os.urandom(8).hex()
    root = JOB_DIR / 'image' / result_id
    out_dir = root / 'outputs'
    asset_dir = out_dir / 'assets'
    out_dir.mkdir(parents=True, exist_ok=True)
    asset_dir.mkdir(parents=True, exist_ok=True)

    fmt = 'webp' if str(options.output_format).lower() == 'webp' else 'png'
    ext = 'webp' if fmt == 'webp' else 'png'
    outputs: list[dict] = []
    all_assets: list[Image.Image] = []
    regions_report: list[dict] = []
    reports = []
    first_preview = None
    first_alpha = None
    last_size = [0, 0]
    files_processed = 0

    for file_index, (original_name, path) in enumerate(uploaded, 1):
        try:
            img = Image.open(path)
        except Exception:
            continue
        files_processed += 1
        stem = Path(original_name).stem or f'image_{file_index}'
        cut, alpha_img, report = cutout_image(img, options)
        last_size = [cut.width, cut.height]
        out_name = f'{stem}_cutout.{ext}'
        alpha_name = f'{stem}_alpha.png'
        save_transparent(cut, out_dir / out_name, fmt)
        alpha_img.save(out_dir / alpha_name)
        if first_preview is None:
            first_preview = out_name
            first_alpha = alpha_name
        reports.append({'file': original_name, **report})

        if options.split_assets:
            regs = detect_regions(cut, options)
            for j, region in enumerate(regs, 1):
                crop = cut.crop((region['x'], region['y'], region['x'] + region['w'], region['y'] + region['h']))
                asset_name = f'{stem}_asset_{j:03d}.{ext}'
                save_transparent(crop, asset_dir / asset_name, fmt)
                rel_url = f'/api/image/results/{result_id}/assets/{asset_name}'
                entry = {'name': asset_name, **region, 'url': rel_url}
                regions_report.append(entry)
                all_assets.append(crop)
        else:
            all_assets.append(cut)

    if all_assets:
        sheet = build_sheet(all_assets, options.sheet_columns, options.sheet_gap)
        if sheet:
            save_transparent(sheet, out_dir / f'sprite_sheet.{ext}', fmt)

    # Metadata files. The coordinates below point to the generated sprite sheet,
    # not to the original source image.
    texture = {
        'frames': {},
        'meta': {'app': 'Game Asset Studio', 'image': f'sprite_sheet.{ext}', 'format': 'RGBA8888'},
    }
    css_lines = []
    if regions_report and all_assets:
        columns = max(1, min(int(options.sheet_columns or 1), 24))
        gap = max(0, min(int(options.sheet_gap or 0), 64))
        cell_w = max(im.width for im in all_assets)
        cell_h = max(im.height for im in all_assets)
        for idx, region in enumerate(regions_report):
            sx = (idx % columns) * (cell_w + gap)
            sy = (idx // columns) * (cell_h + gap)
            texture['frames'][region['name']] = {
                'frame': {'x': sx, 'y': sy, 'w': region['w'], 'h': region['h']},
                'rotated': False,
                'trimmed': True,
                'spriteSourceSize': {'x': 0, 'y': 0, 'w': region['w'], 'h': region['h']},
                'sourceSize': {'w': region['w'], 'h': region['h']},
            }
            cls = re.sub(r'[^a-zA-Z0-9_-]', '-', Path(region['name']).stem)
            css_lines.append(
                f'.sprite-{cls} {{ width: {region["w"]}px; height: {region["h"]}px; '
                f'background-image: url("sprite_sheet.{ext}"); background-position: -{sx}px -{sy}px; }}'
            )
    (out_dir / 'texturepacker.json').write_text(json.dumps(texture, ensure_ascii=False, indent=2), encoding='utf-8')
    (out_dir / 'sprites.css').write_text('\n'.join(css_lines), encoding='utf-8')
    (out_dir / 'report.json').write_text(json.dumps({'files_processed': files_processed, 'regions': regions_report, 'reports': reports}, ensure_ascii=False, indent=2), encoding='utf-8')

    zip_path = out_dir / 'image_cutout_assets.zip'
    with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for file_path in out_dir.rglob('*'):
            if file_path == zip_path or file_path.is_dir():
                continue
            zf.write(file_path, file_path.relative_to(out_dir).as_posix())

    for file_path in out_dir.rglob('*'):
        if file_path.is_file():
            rel = file_path.relative_to(out_dir).as_posix()
            if rel.startswith('assets/'):
                continue
            outputs.append({'name': rel, 'url': f'/api/image/results/{result_id}/{rel}', 'size_bytes': file_path.stat().st_size})

    if first_preview is None:
        raise ValueError('没有成功处理任何图片')

    return {
        'id': result_id,
        'preview_url': f'/api/image/results/{result_id}/{first_preview}',
        'alpha_url': f'/api/image/results/{result_id}/{first_alpha}',
        'sheet_url': f'/api/image/results/{result_id}/sprite_sheet.{ext}' if (out_dir / f'sprite_sheet.{ext}').exists() else None,
        'report_url': f'/api/image/results/{result_id}/report.json',
        'zip_url': f'/api/image/results/{result_id}/image_cutout_assets.zip',
        'width': last_size[0],
        'height': last_size[1],
        'files_processed': files_processed,
        'regions': regions_report,
        'outputs': outputs,
    }
