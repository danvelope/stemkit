import argparse
import json
import struct
import sys
import time
import wave

import numpy as np


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def load_wav(path):
    try:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except Exception as e:
        fail(f"cannot read wav {path}: {e}")
    if width == 2:
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(frames, dtype="<f4").astype(np.float32)
    else:
        fail(f"unsupported sample width {width}")
    if channels == 0:
        fail("empty wav")
    audio = audio.reshape(-1, channels).T
    return audio, sr


def save_wav_f32(path, data, sr):
    """write a 32-bit float wav (fmt tag 3); values above 1.0 are preserved"""
    channels, _ = data.shape
    payload = data.T.astype("<f4").tobytes()
    block_align = channels * 4
    header = b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 3, channels, sr, sr * block_align, block_align, 32
    )
    header += b"data" + struct.pack("<I", len(payload))
    with open(path, "wb") as f:
        f.write(header)
        f.write(payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--shifts", type=int, default=1)
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    import torch
    import types

    import demucs.apply as dapply

    raw_tqdm = dapply.tqdm
    is_module = not hasattr(raw_tqdm, "update")
    real_tqdm = raw_tqdm.tqdm if is_module else raw_tqdm

    # demucs runs one tqdm per "leg" (bag model x shift), each sweeping 0-100
    # on its own. The UI expects a single monotonic sweep for the whole call,
    # so legs are counted globally: pct = (legs_done + leg_frac) / legs.
    # legs_total is filled in once the model is loaded (the patch installs
    # before that point)
    leg_state = {"done": 0, "total": 0, "last": -1.0, "legs": 0}

    class ProgressTqdm(real_tqdm):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            if self.total:
                leg_state["total"] = self.total

        def update(self, n=1):
            super().update(n)
            self._report(False)

        def close(self):
            self._report(True)
            if self.total and self.n >= self.total:
                leg_state["done"] += 1
            super().close()

        def _report(self, force):
            legs = leg_state["legs"]
            if not legs:
                return
            total = leg_state["total"] or self.total or 0
            if not total:
                return
            frac = min(1.0, max(0.0, self.n / total))
            now = time.time()
            if force or now - leg_state["last"] >= 0.5:
                global_pct = int(
                    ((leg_state["done"] + frac) / legs) * 100
                )
                emit(type="progress", stage="separate", pct=min(99, global_pct))
                leg_state["last"] = now

    dapply.tqdm = types.SimpleNamespace(tqdm=ProgressTqdm) if is_module else ProgressTqdm

    if args.device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    else:
        device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no NVIDIA GPU, or the CUDA build of torch is not installed)")
    emit(type="progress", stage="model", pct=0, message=f"loading {args.model} on {device}")

    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    try:
        model = get_model(args.model)
    except Exception as e:
        fail(f"model load failed: {e}")
    model.to(device)
    model.eval()
    leg_state["legs"] = max(1, len(getattr(model, "models", [1]))) * max(1, args.shifts)

    audio, sr = load_wav(args.input)
    target_sr = model.samplerate
    if sr != target_sr:
        import torchaudio

        t = torch.from_numpy(audio)
        t = torchaudio.functional.resample(t, sr, target_sr)
        audio = t.numpy()
        sr = target_sr
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)

    mix = torch.from_numpy(audio).to(device)[None]

    emit(type="progress", stage="separate", pct=0, message="separating")
    try:
        sources = apply_model(
            model,
            mix,
            device=device,
            shifts=args.shifts,
            split=True,
            overlap=args.overlap,
            progress=True,
        )
    except Exception as e:
        if device == "mps":
            emit(
                type="progress",
                stage="separate",
                pct=0,
                message=f"mps failed ({e}), falling back to cpu",
            )
            model = model.cpu()
            mix = mix.cpu()
            device = "cpu"
            sources = apply_model(
                model,
                mix,
                device=device,
                shifts=args.shifts,
                split=True,
                overlap=args.overlap,
                progress=True,
            )
        else:
            fail(f"separation failed: {e}")

    import os

    wanted = None
    if args.only:
        wanted = [s.strip() for s in args.only.split(",") if s.strip()]
        unknown = [s for s in wanted if s not in model.sources]
        if unknown:
            fail(f"unknown stems requested: {', '.join(unknown)}")
        if not wanted:
            fail("no valid stems requested")
        emit(type="progress", stage="separate", pct=0, message=f"writing {len(wanted)} stems")

    os.makedirs(args.out, exist_ok=True)
    out_cpu = sources[0].cpu().numpy()
    written = []
    for i, name in enumerate(model.sources):
        if wanted is not None and name not in wanted:
            continue
        path = os.path.join(args.out, f"{name}.wav")
        save_wav_f32(path, out_cpu[i], sr)
        written.append(name)
        emit(type="stem", name=name)

    emit(type="done", stems=written, out_dir=args.out)


if __name__ == "__main__":
    main()
