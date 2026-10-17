"""Normalize original transparent GIFs into a consistent 300x300 playback canvas.

Requires Pillow and NumPy only to regenerate assets, not to run the app.
Original GIFs are retained. Alpha, frames, and durations are preserved except
for isolated, thin border fragments left in a few original first frames.
"""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageSequence

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'assets' / 'rice-rendered'
DEST.mkdir(exist_ok=True)

# 按人物头身比例和脚底校准，不能按每套动画的外接框分别放大：
# 尾巴、标点和边框残留会撑大外接框，造成切换动作时人物忽大忽小。
# 每项为（倍率、原图锚点、目标锚点），坐标单位为像素。
# 同一动画所有帧共用变换，保留原有呼吸、蹦跳和歪头，不逐帧重新对齐。
STANDING_SCALE = 1.6
LAYOUT = {
    'idle': (STANDING_SCALE, (148, 160), (135, 280)),
    'pat': (STANDING_SCALE, (142, 155), (135, 280)),
    'happy': (STANDING_SCALE, (143, 155), (135, 280)),
    'angry': (STANDING_SCALE, (147, 157), (135, 280)),
    'approval': (STANDING_SCALE, (144, 155), (135, 280)),
    'question': (STANDING_SCALE, (146, 155), (135, 280)),
    'error': (STANDING_SCALE, (144, 155), (135, 280)),
    # 坐姿、趴姿原图的人物比例不同，单独校准；站立互动统一使用上面的倍率。
    'thinking': (1.05, (130, 274), (130, 280)),
    'coding': (0.96, (154, 260), (150, 280)),
    'success': (0.8, (133, 294), (135, 280)),
    'sleep': (1.1, (155, 156), (150, 280)),
}


def remove_border_fragments(image):
    # 按透明度寻找四邻域连通块，不按背景颜色抠图，避免误删人物自身颜色。
    data = np.array(image)
    h, w = data.shape[:2]
    alpha = data[:, :, 3].copy().reshape(-1)
    visited = bytearray(w * h)
    removed = 0
    for start in np.flatnonzero(alpha):
        start = int(start)
        if visited[start]:
            continue
        component = [start]
        visited[start] = 1
        left, right, top, bottom = start % w, start % w, start // w, start // w
        for current in component:
            x, y = current % w, current // w
            left, right = min(left, x), max(right, x)
            top, bottom = min(top, y), max(bottom, y)
            adjacent = []
            if x: adjacent.append(current - 1)
            if x < w - 1: adjacent.append(current + 1)
            if y: adjacent.append(current - w)
            if y < h - 1: adjacent.append(current + w)
            for neighbor in adjacent:
                if alpha[neighbor] and not visited[neighbor]:
                    visited[neighbor] = 1
                    component.append(neighbor)
        touches_edge = left == 0 or top == 0 or right == w - 1 or bottom == h - 1
        width, height = right - left + 1, bottom - top + 1
        # 仅清理接触画布边缘且很细或稀疏的块，针对部分首帧的边框残留。
        if touches_edge and (min(width, height) <= 3 or len(component) / (width * height) < 0.08):
            alpha[component] = 0
            removed += len(component)
    data[:, :, 3] = alpha.reshape(h, w)
    data[data[:, :, 3] == 0] = 0
    return Image.fromarray(data), removed


report = {}
for source in sorted((ROOT / 'assets' / 'rice').glob('*.gif')):
    original = Image.open(source)
    frames, durations = [], []
    union = None
    removed = 0
    for frame in ImageSequence.Iterator(original):
        clean, count = remove_border_fragments(frame.convert('RGBA'))
        removed += count
        bbox = clean.getbbox()
        if bbox:
            union = bbox if union is None else (min(union[0],bbox[0]),min(union[1],bbox[1]),max(union[2],bbox[2]),max(union[3],bbox[3]))
        frames.append(clean)
        durations.append(frame.info.get('duration', 80))
    output = []
    scale, anchor, target = LAYOUT[source.stem]
    for frame in frames:
        art = frame.resize((round(frame.width * scale), round(frame.height * scale)), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (300, 300))
        canvas.alpha_composite(art, (round(target[0] - anchor[0] * scale), round(target[1] - anchor[1] * scale)))
        output.append(canvas)
    # 写入播放副本并保留逐帧时长；原始 GIF 留在 rice 目录，便于追溯和重新生成。
    output[0].save(DEST / f'{source.stem}.webp', save_all=True, append_images=output[1:], duration=durations, loop=0, lossless=True)
    report[source.stem] = {'frames':len(frames), 'durationMs':sum(durations), 'sourceSize':list(original.size), 'contentBounds':list(union), 'scale':scale, 'anchor':list(anchor), 'target':list(target), 'removedBorderPixels':removed}
    print(source.name, report[source.stem], flush=True)
(DEST / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
