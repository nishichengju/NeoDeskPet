# -*- coding: utf-8 -*-
"""
SenseVoiceSmall 语音识别服务（本地）

提供两种使用方式：
- /asr: 传统“录完再识别”的 HTTP POST（Float32 PCM）
- /ws : WebSocket 实时音频流（Float32 PCM）+ FSMN streaming VAD 端点检测 + SenseVoiceSmall 分段转写

说明：
- 浏览器侧上传的是 Float32 PCM（小端、单声道），采样率为 AudioContext.sampleRate
- 服务端会自动重采样到 16k 供 VAD/ASR 使用
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

try:
    import torchaudio
except Exception:
    torchaudio = None


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "GPT-SoVITS-v2_ProPlus", "SenseVoiceSmall"))
VAD_MODEL_DIR = os.path.abspath(os.path.join(MODEL_DIR, "models", "iic", "speech_fsmn_vad_zh-cn-16k-common-pytorch"))
WEB_DIR = BASE_DIR

TARGET_SAMPLE_RATE = 16000

app = FastAPI()
asr_model = None
vad_model = None
_ASR_LOCK = asyncio.Lock()


@dataclass
class DecodeOptions:
    language: str = "auto"  # "zn", "en", "yue", "ja", "ko", "nospeech"
    use_itn: bool = True


@dataclass
class WsClientConfig:
    sample_rate: int = TARGET_SAMPLE_RATE
    language: str = "auto"
    use_itn: bool = True
    vad_chunk_ms: int = 200
    max_end_silence_ms: int = 800
    min_speech_ms: int = 600
    max_speech_ms: int = 15000
    preroll_ms: int = 120
    postroll_ms: int = 80
    enable_agc: bool = True
    agc_target_rms: float = 0.05
    agc_max_gain: float = 20.0
    debug: bool = False


def _now_ms() -> int:
    return int(time.time() * 1000)


def _safe_float32_audio(x: np.ndarray) -> np.ndarray:
    if x.dtype != np.float32:
        x = x.astype(np.float32, copy=False)
    if not np.isfinite(x).all():
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32, copy=False)
    return x


def _resample(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    audio = _safe_float32_audio(audio)
    if src_sr == dst_sr:
        return audio

    if torchaudio is not None:
        wav = torch.from_numpy(audio).unsqueeze(0)  # [1, T]
        wav = torchaudio.functional.resample(wav, orig_freq=int(src_sr), new_freq=int(dst_sr))
        return wav.squeeze(0).cpu().numpy().astype(np.float32, copy=False)

    # 回退：线性插值（质量不如 torchaudio，但足够用来 Demo/集成）
    ratio = dst_sr / float(src_sr)
    new_len = max(1, int(round(audio.shape[0] * ratio)))
    x_old = np.linspace(0.0, 1.0, num=audio.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=new_len, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32, copy=False)


def _apply_agc(audio: np.ndarray, target_rms: float = 0.05, max_gain: float = 20.0) -> np.ndarray:
    """
    简单自动增益：把 RMS 拉到 target_rms（最多放大 max_gain 倍）
    """

    audio = _safe_float32_audio(audio)
    rms = float(np.sqrt(np.mean(audio * audio)) + 1e-8)
    gain = min(max_gain, target_rms / rms)
    if gain <= 1.0:
        return audio
    return np.clip(audio * gain, -1.0, 1.0).astype(np.float32, copy=False)


def _ms_to_samples(ms: int) -> int:
    return int(round(ms * TARGET_SAMPLE_RATE / 1000.0))


def _clamp_int(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(value)))


def _clamp_float(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(value)))


def init_model() -> None:
    global asr_model, vad_model

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"SenseVoiceSmall 模型目录不存在: {MODEL_DIR}")
    if not os.path.isdir(VAD_MODEL_DIR):
        raise RuntimeError(f"FSMN-VAD 模型目录不存在: {VAD_MODEL_DIR}")

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"[SenseVoice] 使用设备: {device}")
    print(f"[SenseVoice] ASR 模型目录: {MODEL_DIR}")
    print(f"[SenseVoice] VAD 模型目录: {VAD_MODEL_DIR}")

    # trust_remote_code=False => 使用 funasr 内置 sense_voice 实现（本仓库自带模型文件）
    asr_model = AutoModel(model=MODEL_DIR, device=device, disable_update=True, trust_remote_code=False)
    vad_model = AutoModel(model=VAD_MODEL_DIR, device=device, disable_update=True, trust_remote_code=False)

    # GPU 推理时，CPU 线程过多会导致整体占用异常高；这里做个保守限流
    try:
        cpu = os.cpu_count() or 4
        torch.set_num_threads(max(1, min(4, cpu // 2)))
        torch.set_num_interop_threads(1)
    except Exception:
        pass


@app.on_event("startup")
async def startup() -> None:
    init_model()


@app.get("/")
async def index():
    return FileResponse(os.path.join(WEB_DIR, "sensevoice_web.html"))


@app.get("/health")
async def health():
    return JSONResponse({"ok": True, "ts": _now_ms()})


def _transcribe_sync(audio_16k: np.ndarray, opts: DecodeOptions) -> str:
    """
    同步转写：传入 16k 单声道 float32
    """
    res = asr_model.generate(
        input=audio_16k,
        cache={},
        language=opts.language,
        use_itn=opts.use_itn,
        batch_size_s=60,
        disable_pbar=True,
    )
    if not res:
        return ""
    text = str((res[0] or {}).get("text", "")).strip()
    if not text:
        return ""
    return rich_transcription_postprocess(text)


@app.post("/asr")
async def asr(request: Request):
    """
    请求体：Float32 PCM（小端）、单声道
    Query:
      - sr: 采样率（AudioContext.sampleRate）
      - lang: auto/zn/en/yue/ja/ko/nospeech
      - itn: 0/1
    """
    sr = int(request.query_params.get("sr", str(TARGET_SAMPLE_RATE)))
    lang = (request.query_params.get("lang") or "auto").strip()
    itn = (request.query_params.get("itn") or "1").strip() not in ("0", "false", "False")

    body = await request.body()
    if not body:
        return JSONResponse({"ok": False, "error": "empty body"}, status_code=400)

    audio = np.frombuffer(body, dtype=np.float32)
    audio = _safe_float32_audio(audio)
    audio = _apply_agc(audio)
    audio_16k = _resample(audio, src_sr=sr, dst_sr=TARGET_SAMPLE_RATE)

    t0 = time.perf_counter()
    async with _ASR_LOCK:
        text = await asyncio.to_thread(_transcribe_sync, audio_16k, DecodeOptions(language=lang, use_itn=itn))
    t1 = time.perf_counter()

    return JSONResponse(
        {
            "ok": True,
            "text": text,
            "input": {"sr": sr, "samples": int(audio.shape[0]), "seconds": round(audio.shape[0] / float(sr), 3)},
            "processing": {"seconds": round(t1 - t0, 3)},
        }
    )


def _safe_config_update(cfg: WsClientConfig, patch: dict) -> WsClientConfig:
    next_cfg = WsClientConfig(**{**cfg.__dict__})
    if "sampleRate" in patch:
        next_cfg.sample_rate = _clamp_int(int(patch["sampleRate"]), 8000, 192000)
    if "language" in patch:
        next_cfg.language = str(patch["language"]).strip() or "auto"
    if "useItn" in patch:
        next_cfg.use_itn = bool(patch["useItn"])
    if "vadChunkMs" in patch:
        next_cfg.vad_chunk_ms = _clamp_int(int(patch["vadChunkMs"]), 40, 800)
    if "maxEndSilenceMs" in patch:
        next_cfg.max_end_silence_ms = _clamp_int(int(patch["maxEndSilenceMs"]), 80, 4000)
    if "minSpeechMs" in patch:
        next_cfg.min_speech_ms = _clamp_int(int(patch["minSpeechMs"]), 0, 5000)
    if "maxSpeechMs" in patch:
        next_cfg.max_speech_ms = _clamp_int(int(patch["maxSpeechMs"]), 800, 60000)
    if "prerollMs" in patch:
        next_cfg.preroll_ms = _clamp_int(int(patch["prerollMs"]), 0, 2000)
    if "postrollMs" in patch:
        next_cfg.postroll_ms = _clamp_int(int(patch["postrollMs"]), 0, 2000)
    if "enableAgc" in patch:
        next_cfg.enable_agc = bool(patch["enableAgc"])
    if "agcTargetRms" in patch:
        next_cfg.agc_target_rms = _clamp_float(float(patch["agcTargetRms"]), 0.005, 0.2)
    if "agcMaxGain" in patch:
        next_cfg.agc_max_gain = _clamp_float(float(patch["agcMaxGain"]), 1.0, 80.0)
    if "debug" in patch:
        next_cfg.debug = bool(patch["debug"])
    return next_cfg


async def _send_ws_json(websocket: WebSocket, payload: dict) -> None:
    try:
        await websocket.send_text(json.dumps(payload, ensure_ascii=False))
    except Exception:
        # 客户端已关闭/断开时，继续 send 会触发异常；这里直接忽略，避免刷屏
        return


@app.websocket("/ws")
async def ws_asr(websocket: WebSocket):
    await websocket.accept()

    cfg = WsClientConfig()
    vad_cache: dict = {}
    speech_start_ms: Optional[int] = None

    # 16k 域的累计处理样本数（用于生成 now_ms）
    processed_samples_16k = 0

    # 16k 音频环形缓存：用 deque 避免每次 append 都整段复制导致 CPU 飙升
    buffer_start_sample = 0  # 16k 域：当前 buffer 的起始 sample index（全局时间轴）
    audio_chunks: "deque[np.ndarray]" = deque()
    audio_total_samples = 0

    # 输入端（原始采样率）缓存：累积到 vadChunkMs 再重采样到 16k 喂给 VAD
    src_chunks: "deque[np.ndarray]" = deque()
    src_available_samples = 0
    src_head_offset = 0

    # torchaudio 重采样器缓存（按 src_sr 复用，避免频繁创建）
    resampler_src_sr: Optional[int] = None
    resampler = None

    def get_resampler(src_sr: int):
        nonlocal resampler_src_sr, resampler
        if torchaudio is None:
            return None
        if resampler is not None and resampler_src_sr == int(src_sr):
            return resampler
        resampler_src_sr = int(src_sr)
        resampler = torchaudio.transforms.Resample(orig_freq=int(src_sr), new_freq=TARGET_SAMPLE_RATE)
        return resampler

    def resample_to_16k(audio: np.ndarray, src_sr: int, expected_len: int) -> np.ndarray:
        audio = _safe_float32_audio(audio)
        if int(src_sr) == TARGET_SAMPLE_RATE:
            out = audio
        elif torchaudio is not None:
            r = get_resampler(int(src_sr))
            wav = torch.from_numpy(audio).unsqueeze(0)  # [1, T]
            wav = r(wav)
            out = wav.squeeze(0).cpu().numpy().astype(np.float32, copy=False)
        else:
            out = _resample(audio, src_sr=int(src_sr), dst_sr=TARGET_SAMPLE_RATE)

        # 固定长度对齐，避免采样率换算四舍五入造成 VAD 时间漂移
        if out.size > expected_len:
            return out[:expected_len].astype(np.float32, copy=False)
        if out.size < expected_len:
            pad = np.zeros((expected_len - out.size,), dtype=np.float32)
            return np.concatenate([out, pad]).astype(np.float32, copy=False)
        return out.astype(np.float32, copy=False)

    def append_audio_16k(chunk: np.ndarray) -> None:
        nonlocal audio_total_samples, buffer_start_sample
        if chunk.size <= 0:
            return
        audio_chunks.append(chunk)
        audio_total_samples += int(chunk.size)

        keep_ms = max(cfg.max_speech_ms + cfg.preroll_ms + cfg.postroll_ms + cfg.max_end_silence_ms + 2000, 45000)
        keep_samples = _ms_to_samples(int(keep_ms))
        if audio_total_samples <= keep_samples:
            return

        drop = int(audio_total_samples - keep_samples)
        while drop > 0 and audio_chunks:
            head = audio_chunks[0]
            if head.size <= drop:
                audio_chunks.popleft()
                audio_total_samples -= int(head.size)
                buffer_start_sample += int(head.size)
                drop -= int(head.size)
                continue

            # drop 只需要切掉头部一部分
            audio_chunks[0] = head[drop:].astype(np.float32, copy=False)
            audio_total_samples -= drop
            buffer_start_sample += drop
            drop = 0

    def slice_audio_16k(start_sample: int, end_sample: int) -> np.ndarray:
        if end_sample <= start_sample:
            return np.zeros((0,), dtype=np.float32)

        rel_start = int(start_sample - buffer_start_sample)
        rel_end = int(end_sample - buffer_start_sample)
        if rel_end <= 0 or rel_start >= audio_total_samples:
            return np.zeros((0,), dtype=np.float32)

        rel_start = max(0, rel_start)
        rel_end = min(audio_total_samples, rel_end)
        if rel_end <= rel_start:
            return np.zeros((0,), dtype=np.float32)

        parts = []
        pos = 0
        for c in audio_chunks:
            next_pos = pos + int(c.size)
            if next_pos <= rel_start:
                pos = next_pos
                continue
            if pos >= rel_end:
                break
            s = max(0, rel_start - pos)
            e = min(int(c.size), rel_end - pos)
            if e > s:
                parts.append(c[s:e])
            pos = next_pos

        if not parts:
            return np.zeros((0,), dtype=np.float32)
        if len(parts) == 1:
            return parts[0].astype(np.float32, copy=False)
        return np.concatenate(parts).astype(np.float32, copy=False)

    async def transcribe_segment(start_ms: int, end_ms: int, now_ms: int) -> None:
        extract_start_ms = max(0, start_ms - cfg.preroll_ms)
        extract_end_ms = min(now_ms, end_ms + cfg.postroll_ms)

        speech_ms = max(0, end_ms - start_ms)
        if speech_ms < cfg.min_speech_ms:
            if cfg.debug:
                await _send_ws_json(websocket, {"type": "debug", "message": f"skip short speech: {speech_ms}ms"})
            return

        start_sample = _ms_to_samples(int(extract_start_ms))
        end_sample = _ms_to_samples(int(extract_end_ms))
        segment = slice_audio_16k(start_sample, end_sample)
        if segment.size <= 0:
            if cfg.debug:
                await _send_ws_json(websocket, {"type": "debug", "message": "skip empty segment (buffer underflow)"})
            return
        if cfg.enable_agc:
            segment = _apply_agc(segment, target_rms=float(cfg.agc_target_rms), max_gain=float(cfg.agc_max_gain))

        t0 = time.perf_counter()
        async with _ASR_LOCK:
            text = await asyncio.to_thread(_transcribe_sync, segment, DecodeOptions(language=cfg.language, use_itn=cfg.use_itn))
        t1 = time.perf_counter()

        await _send_ws_json(
            websocket,
            {
                "type": "result",
                "text": text,
                "startMs": int(start_ms),
                "endMs": int(end_ms),
                "processingMs": int(round((t1 - t0) * 1000)),
                "ts": _now_ms(),
            },
        )

    try:
        await _send_ws_json(websocket, {"type": "ready", "ts": _now_ms()})

        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()

            text = message.get("text")
            data = message.get("bytes")

            if text is not None:
                try:
                    payload = json.loads(text)
                except Exception:
                    continue
                msg_type = str(payload.get("type") or "").strip().lower()
                if msg_type == "config":
                    cfg = _safe_config_update(cfg, payload)
                    vad_cache = {}
                    speech_start_ms = None
                    processed_samples_16k = 0
                    buffer_start_sample = 0
                    audio_chunks.clear()
                    audio_total_samples = 0
                    src_chunks.clear()
                    src_available_samples = 0
                    src_head_offset = 0
                    resampler_src_sr = None
                    resampler = None
                    if cfg.debug:
                        await _send_ws_json(websocket, {"type": "debug", "message": f"config updated: {cfg.__dict__}"})
                    await _send_ws_json(websocket, {"type": "configAck", "ts": _now_ms()})
                continue

            if not data:
                continue

            chunk = np.frombuffer(data, dtype=np.float32)
            chunk = _safe_float32_audio(chunk)

            src_chunks.append(chunk)
            src_available_samples += int(chunk.size)

            # 以“客户端采样率”累计到 vadChunkMs，再重采样到 16k 喂给 VAD/ASR
            src_need = int(round(cfg.vad_chunk_ms * float(cfg.sample_rate) / 1000.0))
            src_need = max(1, src_need)
            expected_16k = max(1, _ms_to_samples(int(cfg.vad_chunk_ms)))

            while src_available_samples >= src_need:
                feed_src = np.empty((src_need,), dtype=np.float32)
                filled = 0
                while filled < src_need and src_chunks:
                    head = src_chunks[0]
                    avail = int(head.size) - int(src_head_offset)
                    take = min(avail, src_need - filled)
                    feed_src[filled : filled + take] = head[src_head_offset : src_head_offset + take]
                    filled += take
                    src_head_offset += take
                    src_available_samples -= take
                    if src_head_offset >= int(head.size):
                        src_chunks.popleft()
                        src_head_offset = 0

                feed_16k = resample_to_16k(feed_src, src_sr=int(cfg.sample_rate), expected_len=expected_16k)
                append_audio_16k(feed_16k)

                processed_samples_16k += expected_16k
                now_ms = int(round(processed_samples_16k / float(TARGET_SAMPLE_RATE) * 1000.0))

                # fsmn-vad streaming: value is list of [start_ms, end_ms] (ms).
                res = vad_model.generate(
                    input=feed_16k,
                    cache=vad_cache,
                    is_final=False,
                    chunk_size=int(cfg.vad_chunk_ms),
                    max_end_silence_time=int(cfg.max_end_silence_ms),
                    disable_pbar=True,
                )
                values = []
                if isinstance(res, list) and res:
                    values = (res[0] or {}).get("value") or []

                for item in values:
                    if not isinstance(item, (list, tuple)) or len(item) != 2:
                        continue
                    start_ms, end_ms = int(item[0]), int(item[1])

                    if start_ms >= 0 and end_ms >= 0:
                        await transcribe_segment(start_ms, end_ms, now_ms)
                        speech_start_ms = None
                        continue

                    if start_ms >= 0 and end_ms < 0:
                        if speech_start_ms is None:
                            speech_start_ms = start_ms
                            if cfg.debug:
                                await _send_ws_json(websocket, {"type": "debug", "message": f"speech start: {start_ms}ms"})
                        continue

                    if start_ms < 0 and end_ms >= 0:
                        if speech_start_ms is not None:
                            await transcribe_segment(speech_start_ms, end_ms, now_ms)
                            if cfg.debug:
                                await _send_ws_json(websocket, {"type": "debug", "message": f"speech end: {end_ms}ms"})
                            speech_start_ms = None
                        continue

                if speech_start_ms is not None and (now_ms - speech_start_ms) >= cfg.max_speech_ms:
                    # 兜底：极长连续说话强制切分，避免一直不出结果
                    forced_end = now_ms
                    await transcribe_segment(speech_start_ms, forced_end, now_ms)
                    speech_start_ms = None
                    vad_cache = {}
                    src_chunks.clear()
                    src_available_samples = 0
                    src_head_offset = 0

    except WebSocketDisconnect:
        # 断开后不要再尝试 send（否则会触发“Cannot call send once a close message has been sent.”）
        return


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8766)
