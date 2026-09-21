#!/usr/bin/env python3
"""
Test a trained openWakeWord model against YOUR OWN voice clips.

This is how Harman's recordings are actually used: the official
openWakeWord trainer builds the model from synthetic speech (thousands of
voice variations), and this script checks that it really hears *his* voice
-- and picks a threshold that balances misses vs. false wakes.

Usage (inside the vyra-wakeword venv on Windows):

    python test_model.py --model "%USERPROFILE%\\.vyra\\wakeword\\vira.onnx" ^
        --clips .\\wakeword-samples

For each 2-second clip it prints the detection score and reports the
detection rate at thresholds 0.5, 0.6 and 0.7. If you also record a few
clips of other people talking / background noise, pass them with --negatives
to check the false-wake rate.
"""

from __future__ import annotations

import argparse
import sys
import wave
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", required=True, help="path to the trained .onnx model")
    p.add_argument("--clips", required=True,
                   help="folder of 2-second 16 kHz mono WAV clips of you saying the wake word")
    p.add_argument("--negatives", default=None,
                   help="optional folder of WAV clips that must NOT wake (other speech/noise)")
    return p.parse_args()


def check_wav16(path: Path) -> None:
    """Validate a 16 kHz mono 16-bit WAV (predict_clip needs this format)."""
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(
                f"{path.name}: need 16 kHz mono 16-bit WAV "
                f"(got {w.getframerate()} Hz, {w.getnchannels()} ch, {w.getsampwidth()*8}-bit)"
            )


def main() -> int:
    args = parse_args()

    try:
        from openwakeword.model import Model
    except ImportError:
        print("ERROR: openwakeword is not installed. Run:", file=sys.stderr)
        print("    python -m pip install openwakeword sounddevice numpy", file=sys.stderr)
        return 2

    clips_dir = Path(args.clips)
    wavs = sorted(clips_dir.glob("*.wav"))
    if not wavs:
        print(f"ERROR: no .wav clips found in {clips_dir}", file=sys.stderr)
        print("Record some first:  python record_samples.py", file=sys.stderr)
        return 2

    name = Path(args.model).stem
    oww = Model(wakeword_models=[args.model], inference_framework="onnx")

    print(f"model: {args.model}")
    print(f"testing {len(wavs)} of YOUR clips...\n")

    scores = []
    for wav in wavs:
        check_wav16(wav)
        score = float(oww.predict_clip(str(wav))[name])
        scores.append(score)
        print(f"  {wav.name}: {score:.2f}")
        oww.reset()

    print()
    for thr in (0.5, 0.6, 0.7):
        detected = sum(1 for s in scores if s >= thr)
        print(f"  threshold {thr:.1f}: {detected}/{len(scores)} clips would wake VYRA")

    if args.negatives:
        neg_dir = Path(args.negatives)
        neg_wavs = sorted(neg_dir.glob("*.wav"))
        print(f"\nchecking {len(neg_wavs)} negative clips (must NOT wake)...")
        for thr in (0.5, 0.6, 0.7):
            false_wakes = 0
            for wav in neg_wavs:
                check_wav16(wav)
                if float(oww.predict_clip(str(wav))[name]) >= thr:
                    false_wakes += 1
                oww.reset()
            print(f"  threshold {thr:.1f}: {false_wakes}/{len(neg_wavs)} false wakes")

    best = min((0.5, 0.6, 0.7), key=lambda t: abs(sum(1 for s in scores if s >= t) / len(scores) - 1.0))
    print(f"\nsuggested starting threshold: {best:.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
