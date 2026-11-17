"""Intercom speech sidecar: local speech-to-text and text-to-speech on the Mac mini (spec §4).

  POST /stt?prompt=...   body: audio bytes (webm/mp4/wav...)  -> {"text": "..."}
  POST /tts              body: {"text", "voice", "speed"}     -> audio/wav
  GET  /healthz                                                -> {"ok": true, ...}

Binds 127.0.0.1 only; Intercom's Node server is the only caller. Audio is written to a private temp
file only for as long as ffmpeg/Whisper need it, then deleted (spec §12).
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("INTERCOM_SIDECAR_PORT", "4178"))
MODELS = Path(os.environ.get("INTERCOM_MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))
WHISPER_MODEL = os.environ.get("INTERCOM_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
KOKORO_MODEL = MODELS / "kokoro-v1.0.onnx"
KOKORO_VOICES = MODELS / "voices-v1.0.bin"
MAX_AUDIO = 15 * 1024 * 1024
MAX_TEXT = 1200

SUFFIX = {"audio/webm": ".webm", "video/webm": ".webm", "audio/mp4": ".m4a", "video/mp4": ".m4a",
          "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/ogg": ".ogg", "audio/mpeg": ".mp3"}

_lock = threading.Lock()  # one model call at a time; the GPU is shared
_kokoro = None


def kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))
    return _kokoro


def transcribe(audio: bytes, mime: str, prompt: str) -> str:
    import mlx_whisper
    suffix = SUFFIX.get(mime.split(";")[0].strip().lower(), ".bin")
    fd, path = tempfile.mkstemp(prefix="intercom-", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(audio)
        with _lock:
            result = mlx_whisper.transcribe(path, path_or_hf_repo=WHISPER_MODEL, language="en",
                                            initial_prompt=prompt or None, condition_on_previous_text=False)
        return (result.get("text") or "").strip()
    finally:
        os.unlink(path)


def synthesize(text: str, voice: str, speed: float) -> bytes:
    import numpy as np
    with _lock:
        samples, rate = kokoro().create(text, voice=voice, speed=speed, lang="en-us" if voice.startswith("a") else "en-gb")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "IntercomSidecar/0.1"

    def log_message(self, fmt, *args):  # timing only, never content
        pass

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit: int) -> bytes | None:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            self._json(413 if n > limit else 400, {"error": "bad_length"})
            return None
        return self.rfile.read(n)

    def do_GET(self):
        if urlparse(self.path).path == "/healthz":
            ok = KOKORO_MODEL.exists() and KOKORO_VOICES.exists()
            return self._json(200 if ok else 503, {"ok": ok, "whisper": WHISPER_MODEL, "kokoro": ok})
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        url = urlparse(self.path)
        t0 = time.monotonic()
        try:
            if url.path == "/stt":
                audio = self._body(MAX_AUDIO)
                if audio is None:
                    return
                prompt = parse_qs(url.query).get("prompt", [""])[0][:500]
                text = transcribe(audio, self.headers.get("Content-Type", ""), prompt)
                self._json(200, {"text": text, "ms": int((time.monotonic() - t0) * 1000)})
            elif url.path == "/tts":
                raw = self._body(64 * 1024)
                if raw is None:
                    return
                req = json.loads(raw)
                text = str(req.get("text", ""))[:MAX_TEXT].strip()
                if not text:
                    return self._json(400, {"error": "no_text"})
                wav = synthesize(text, str(req.get("voice") or "bm_george"), float(req.get("speed") or 1.0))
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
            else:
                self._json(404, {"error": "not_found"})
        except Exception as e:  # noqa: BLE001 — report, never crash the server
            self._json(500, {"error": e.__class__.__name__, "message": str(e)[:300]})


def main() -> None:
    if os.environ.get("INTERCOM_SIDECAR_WARM", "1") == "1":
        def warm():
            try:
                synthesize("Ready.", "bm_george", 1.0)
                import mlx_whisper  # noqa: F401  (loads MLX; the model downloads on first use)
            except Exception as e:  # noqa: BLE001
                print("warm-up failed:", e, flush=True)
        threading.Thread(target=warm, daemon=True).start()
    print(f"Intercom sidecar on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
