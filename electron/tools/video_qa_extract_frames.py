import argparse
import json
import math
import os
from typing import Any, Dict, List


def clamp_int(v: Any, fallback: int, min_v: int, max_v: int) -> int:
    try:
        n = int(v)
    except Exception:
        return fallback
    return max(min_v, min(max_v, n))


def clamp_float(v: Any, fallback: float, min_v: float, max_v: float) -> float:
    try:
        n = float(v)
    except Exception:
        return fallback
    if not math.isfinite(n):
        return fallback
    return max(min_v, min(max_v, n))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--segment-seconds", default="20")
    parser.add_argument("--frames-per-segment", default="3")
    parser.add_argument("--max-segments", default="8")
    parser.add_argument("--start-seconds", default="0")
    args = parser.parse_args()

    video_path = os.path.abspath(args.video)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    try:
        import cv2  # type: ignore
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"missing cv2: {e}"}))
        return

    if not os.path.isfile(video_path):
        print(json.dumps({"ok": False, "error": "video not found", "videoPath": video_path}))
        return

    seg_seconds = clamp_int(args.segment_seconds, 20, 5, 120)
    frames_per_seg = clamp_int(args.frames_per_segment, 3, 1, 8)
    max_segs = clamp_int(args.max_segments, 8, 1, 60)
    start_seconds = clamp_float(args.start_seconds, 0.0, 0.0, 1e9)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "failed to open video", "videoPath": video_path}))
        return

    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
    duration_sec = (frame_count / fps) if fps > 0.0 and frame_count > 0.0 else 0.0

    def safe_read_at_time(t: float):
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            return None
        return frame

    segments: List[Dict[str, Any]] = []

    for seg_idx in range(max_segs):
        seg_start = start_seconds + float(seg_idx * seg_seconds)
        if duration_sec > 0.0 and seg_start >= duration_sec:
            break
        seg_end = seg_start + float(seg_seconds)
        if duration_sec > 0.0:
            seg_end = min(seg_end, duration_sec)

        # 均匀采样：用 (i+0.5)/N 取中点，避免总是取到切点帧
        times: List[float] = []
        for i in range(frames_per_seg):
            t = seg_start + (i + 0.5) * (float(seg_seconds) / float(frames_per_seg))
            if t < seg_start:
                t = seg_start
            if t > seg_end:
                t = max(seg_start, seg_end - 0.001)
            if duration_sec > 0.0:
                t = min(t, max(0.0, duration_sec - 0.001))
            times.append(t)

        frame_paths: List[str] = []
        for t in times:
            frame = safe_read_at_time(t)
            if frame is None:
                continue
            name = f"seg{seg_idx:03d}_t{int(t*1000):010d}.jpg"
            out_path = os.path.join(out_dir, name)
            try:
                cv2.imwrite(out_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                frame_paths.append(os.path.abspath(out_path))
            except Exception:
                continue

        segments.append(
            {
                "index": seg_idx,
                "startSec": seg_start,
                "endSec": seg_end,
                "frames": frame_paths,
            }
        )

    cap.release()

    out: Dict[str, Any] = {
        "ok": True,
        "videoPath": video_path,
        "outDir": out_dir,
        "fps": fps,
        "frameCount": frame_count,
        "durationSec": duration_sec,
        "segmentSeconds": seg_seconds,
        "framesPerSegment": frames_per_seg,
        "startSeconds": start_seconds,
        "segments": segments,
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

