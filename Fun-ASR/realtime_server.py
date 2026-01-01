"""
实时语音识别 WebSocket 服务端
使用 Fun-ASR 模型进行实时语音转文字
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from funasr import AutoModel

try:
    import torchaudio  # requirements.txt 已声明，若环境缺失则回退到 numpy 插值
except Exception:
    torchaudio = None

app = FastAPI()

TARGET_SAMPLE_RATE = 16000
DEFAULT_LANGUAGE = "中文"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

model = None
_MODEL_LOCK = asyncio.Lock()


@dataclass
class ClientConfig:
    sample_rate: int = TARGET_SAMPLE_RATE
    language: str = DEFAULT_LANGUAGE
    enable_agc: bool = True
    debug: bool = False


def _now_ms() -> int:
    return int(time.time() * 1000)


def _safe_float32_audio(x: np.ndarray) -> np.ndarray:
    if x.dtype != np.float32:
        x = x.astype(np.float32, copy=False)
    if not np.isfinite(x).all():
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0).astype(np.float32, copy=False)
    return x


def _apply_agc(x: np.ndarray, target_rms: float = 0.05, max_gain: float = 20.0) -> np.ndarray:
    """
    简单自动增益：将 RMS 拉到 target_rms（最多放大 max_gain 倍），避免音量过低导致识别差。
    """
    x = _safe_float32_audio(x)
    rms = float(np.sqrt(np.mean(x * x)) + 1e-8)
    gain = min(max_gain, target_rms / rms)
    if gain <= 1.0:
        return x
    return np.clip(x * gain, -1.0, 1.0).astype(np.float32, copy=False)


def _resample_to_16k(audio: np.ndarray, src_sr: int) -> np.ndarray:
    audio = _safe_float32_audio(audio)
    if src_sr == TARGET_SAMPLE_RATE:
        return audio

    if torchaudio is not None:
        wav = torch.from_numpy(audio).unsqueeze(0)  # [1, T]
        wav_16k = torchaudio.functional.resample(wav, orig_freq=int(src_sr), new_freq=TARGET_SAMPLE_RATE)
        return wav_16k.squeeze(0).cpu().numpy().astype(np.float32, copy=False)

    # 回退：线性插值（质量不如 torchaudio，但比直接错采样要好）
    ratio = TARGET_SAMPLE_RATE / float(src_sr)
    new_len = max(1, int(round(audio.shape[0] * ratio)))
    x_old = np.linspace(0.0, 1.0, num=audio.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=new_len, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32, copy=False)


class AdaptiveEnergySegmenter:
    """
    自适应能量分段：
    - 空闲时估计底噪 rms（EMA）
    - rms 超过阈值进入说话状态（带 200ms 预缓冲）
    - 连续静音超过 silence_s 结束一次分段
    - 超过 max_segment_s 强制切段
    """

    def __init__(
        self,
        sample_rate: int,
        min_segment_s: float = 1.2,
        max_segment_s: float = 10.0,
        silence_s: float = 0.6,
        preroll_s: float = 0.2,
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.min_segment_s = float(min_segment_s)
        self.max_segment_s = float(max_segment_s)
        self.silence_s = float(silence_s)
        self.preroll_samples = int(round(preroll_s * self.sample_rate))

        self._pre = np.zeros((0,), dtype=np.float32)
        self._buf = np.zeros((0,), dtype=np.float32)
        self._in_speech = False
        self._silence_acc_s = 0.0
        self._noise_rms = 0.0

    def update_sample_rate(self, sample_rate: int) -> None:
        # 采样率变化后，直接重置状态（浏览器 AudioContext 可能不是 16k）
        self.__init__(sample_rate=sample_rate)

    @staticmethod
    def _chunk_rms(chunk: np.ndarray) -> float:
        if chunk.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(chunk * chunk)) + 1e-8)

    def push(self, chunk: np.ndarray) -> list[np.ndarray]:
        chunk = _safe_float32_audio(chunk)
        if chunk.size == 0:
            return []

        sr = self.sample_rate
        chunk_s = chunk.size / float(sr)
        rms = self._chunk_rms(chunk)

        # 预缓冲：保留最近一小段，以免切掉开头
        if self.preroll_samples > 0:
            if self._pre.size == 0:
                self._pre = chunk[-self.preroll_samples :].copy()
            else:
                self._pre = np.concatenate([self._pre, chunk])[-self.preroll_samples :]

        # 更新底噪（仅在非说话态）
        if not self._in_speech:
            if self._noise_rms <= 0.0:
                self._noise_rms = rms
            else:
                self._noise_rms = 0.95 * self._noise_rms + 0.05 * rms

        start_th = max(self._noise_rms * 3.0, 0.010)
        stop_th = max(self._noise_rms * 1.5, 0.008)

        segments: list[np.ndarray] = []

        if not self._in_speech:
            if rms >= start_th:
                self._in_speech = True
                self._silence_acc_s = 0.0
                self._buf = np.concatenate([self._pre, chunk]).astype(np.float32, copy=False)
            return segments

        # in speech
        self._buf = np.concatenate([self._buf, chunk]).astype(np.float32, copy=False)
        buf_s = self._buf.size / float(sr)

        if rms <= stop_th:
            self._silence_acc_s += chunk_s
        else:
            self._silence_acc_s = 0.0

        should_cut = False
        if buf_s >= self.max_segment_s:
            should_cut = True
        elif self._silence_acc_s >= self.silence_s and buf_s >= self.min_segment_s:
            should_cut = True

        if should_cut:
            trim_silence_samples = int(round(min(self._silence_acc_s, self.silence_s) * sr))
            if 0 < trim_silence_samples < self._buf.size:
                seg = self._buf[:-trim_silence_samples]
            else:
                seg = self._buf

            segments.append(seg.astype(np.float32, copy=False))
            self._buf = np.zeros((0,), dtype=np.float32)
            self._in_speech = False
            self._silence_acc_s = 0.0

        return segments


def init_model() -> None:
    global model
    print("正在加载 Fun-ASR 模型...")

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"使用设备: {device}")

    # FunASR 的 remote_code 机制依赖相对导入/注册表，传绝对路径会导致导入失败
    # 这里确保工作目录与 sys.path 包含当前脚本目录，保证 ./model.py 可被加载
    os.chdir(BASE_DIR)
    if BASE_DIR not in sys.path:
        sys.path.insert(0, BASE_DIR)

    model = AutoModel(
        model="FunAudioLLM/Fun-ASR-Nano-2512",
        trust_remote_code=True,
        remote_code="./model.py",
        device=device,
        disable_update=True,
        # 使用官方 VAD，能改善长静音/断句导致的识别问题
        vad_model="fsmn-vad",
        vad_kwargs={"max_single_segment_time": 15000},
    )

    print("模型加载完成!")


@app.on_event("startup")
async def startup() -> None:
    init_model()


@app.get("/")
async def index():
    return FileResponse(os.path.join(BASE_DIR, "realtime_web.html"))


def _recognize_segment_sync(audio_tensor: torch.Tensor, language: str) -> str:
    # 尽量抑制 transformers 的 pad_token_id 警告（该模型 eos id 常见为 151645）
    llm_kwargs = {
        "pad_token_id": 151645,
        "do_sample": False,
        "num_beams": 1,
    }
    result = model.generate(
        input=[audio_tensor],
        cache={},
        batch_size=1,
        language=language,
        itn=True,
        # Fun-ASR 的实现用 max_length 作为 max_new_tokens，限制输出长度可减少“跑偏”
        max_length=192,
        llm_kwargs=llm_kwargs,
    )
    if not result:
        return ""
    text = (result[0] or {}).get("text", "")
    return str(text).strip()


async def _asr_worker(
    websocket: WebSocket,
    queue: "asyncio.Queue[np.ndarray]",
    config: ClientConfig,
    temp_dir: str,
) -> None:
    while True:
        segment = await queue.get()
        try:
            if segment is None:  # type: ignore[comparison-overlap]
                return

            seg = _safe_float32_audio(segment)
            seg_16k = _resample_to_16k(seg, src_sr=config.sample_rate)
            if config.enable_agc:
                seg_16k = _apply_agc(seg_16k)

            # 直接走 tensor 推理，避免写 wav/解码开销（显著降低端到端延迟）
            audio_tensor = torch.from_numpy(seg_16k).to(dtype=torch.float32)
            async with _MODEL_LOCK:
                text = await asyncio.to_thread(_recognize_segment_sync, audio_tensor, config.language)

            if text:
                await websocket.send_json({"type": "result", "text": text})
                if config.debug:
                    print(f"识别结果: {text}")
        finally:
            queue.task_done()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("客户端已连接")

    config = ClientConfig()
    # 低延迟调参：更短的最小切段 + 更短的静音判停
    segmenter = AdaptiveEnergySegmenter(
        sample_rate=config.sample_rate,
        min_segment_s=0.6,
        max_segment_s=3.5,
        silence_s=0.25,
        preroll_s=0.12,
    )
    queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=8)

    temp_dir = tempfile.mkdtemp(prefix="funasr_ws_")
    worker_task = asyncio.create_task(_asr_worker(websocket, queue, config, temp_dir))

    try:
        while True:
            msg = await websocket.receive()

            # 文本消息：配置/心跳
            if msg.get("text") is not None:
                try:
                    data = json.loads(msg["text"])
                except Exception:
                    continue

                msg_type = data.get("type")
                if msg_type == "ping":
                    await websocket.send_json({"type": "pong", "ts": _now_ms()})
                    continue

                if msg_type == "config":
                    sr = data.get("sampleRate")
                    if isinstance(sr, (int, float)) and int(sr) > 0:
                        config.sample_rate = int(sr)
                        segmenter.update_sample_rate(config.sample_rate)

                    lang = data.get("language")
                    if isinstance(lang, str) and lang.strip():
                        config.language = lang.strip()

                    if isinstance(data.get("enableAgc"), bool):
                        config.enable_agc = bool(data["enableAgc"])
                    if isinstance(data.get("debug"), bool):
                        config.debug = bool(data["debug"])

                    if config.debug:
                        print(
                            f"配置已更新: sample_rate={config.sample_rate}, language={config.language}, agc={config.enable_agc}"
                        )
                    continue

                continue

            # 二进制音频流
            if msg.get("bytes") is not None:
                audio_chunk = np.frombuffer(msg["bytes"], dtype=np.float32)
                segments = segmenter.push(audio_chunk)

                if config.debug and segments:
                    for seg in segments:
                        rms = float(np.sqrt(np.mean(seg * seg)) + 1e-8)
                        print(f"切段: {seg.size/config.sample_rate:.2f}s, rms={rms:.4f}, sr={config.sample_rate}")

                for seg in segments:
                    # 队列满时丢弃最老分段，优先保证实时性
                    if queue.full():
                        try:
                            _ = queue.get_nowait()
                            queue.task_done()
                        except Exception:
                            pass
                    await queue.put(seg)

    except WebSocketDisconnect:
        print("客户端断开连接")
    except Exception as e:
        print(f"WebSocket 错误: {e}")
        import traceback

        traceback.print_exc()
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except Exception:
            pass

        try:
            for name in os.listdir(temp_dir):
                try:
                    os.remove(os.path.join(temp_dir, name))
                except Exception:
                    pass
            os.rmdir(temp_dir)
        except Exception:
            pass


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8765,
        ws_ping_interval=20,
        ws_ping_timeout=60,
    )
