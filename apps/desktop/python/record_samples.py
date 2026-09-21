#!/usr/bin/env python3
"""
Record short clips of YOUR OWN voice saying the wake phrase.

These clips are not the training data: the official openWakeWord trainer
builds the model from synthetic speech (thousands of voice variations, so
it works across accents). Your clips are used with test_model.py to check
that the trained model really hears *your* voice -- and to pick a
threshold that balances misses vs. false wakes.

Usage:
  py record_samples.py --phrase vira --count 15 --out wakeword-samples

You will be prompted 15 times: press Enter, say "Vira" once naturally,
and the script saves a 2-second 16 kHz mono WAV clip per take. Vary your
distance, volume and intonation a little between takes.
"""

import argparse
import os
import sys
import wave


def main():
    parser = argparse.ArgumentParser(description="Record wake-word training samples")
    parser.add_argument("--phrase", default="vira")
    parser.add_argument("--count", type=int, default=15)
    parser.add_argument("--out", default="wakeword-samples",
                        help="folder the WAV clips are saved to")
    args = parser.parse_args()

    try:
        import sounddevice as sd
        import numpy as np
    except ImportError:
        sys.stderr.write("Missing packages. Run: py -m pip install sounddevice numpy\n")
        sys.exit(2)

    os.makedirs(args.out, exist_ok=True)
    print("Recording %d samples of \"%s\" into %s" % (args.count, args.phrase, args.out))
    print("Tip: say it the way you naturally would, from different spots in the room.\n")

    saved = 0
    attempt = 0
    while saved < args.count:
        attempt += 1
        try:
            input("[%d/%d] Press Enter, then say \"%s\" ... "
                  % (saved + 1, args.count, args.phrase))
        except (EOFError, KeyboardInterrupt):
            print("\nStopped. Saved %d clips." % saved)
            break
        print("  recording...", end="", flush=True)
        rec = sd.rec(int(2.0 * 16000), samplerate=16000, channels=1, dtype="int16")
        sd.wait()
        print(" done.")
        audio = rec.flatten()
        rms = float(np.sqrt(np.mean((audio.astype(np.float32) / 32768.0) ** 2)))
        if rms < 0.004:
            print("  too quiet (level %.4f) — not saved, let's redo that one." % rms)
            continue
        path = os.path.join(args.out, "clip_%03d.wav" % (saved + 1))
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(audio.tobytes())
        saved += 1
        print("  saved %s (level %.4f)" % (path, rms))

    print("\nDone: %d clips in %s" % (saved, args.out))


if __name__ == "__main__":
    main()
