#!/usr/bin/env python3
"""
VYRA wake-word listener — fully offline, no API key, no signup, no cloud.

Reads the microphone, runs an on-device openWakeWord model, and prints one
JSON object per line on stdout:

  {"event": "ready", "phrase": "vira", "sample_rate": 16000}
  {"event": "wake", "phrase": "vira", "score": 0.87}
  {"event": "command", "text": "open google and search my name"}
  {"event": "error", "message": "..."}

Modes:
  listen      continuous wake detection; after each wake word, capture the
              next spoken command and transcribe it locally with faster-whisper
  check-mic   list input devices, record 3 seconds, report levels

Dependencies (install once): pip install openwakeword sounddevice numpy faster-whisper
"""

import argparse
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def die(message, code=2):
    emit({"event": "error", "message": message})
    sys.stderr.write("vyra-wakeword: " + message + "\n")
    sys.exit(code)


def require_deps(*names):
    missing = []
    mods = {}
    for name in names:
        try:
            mods[name] = __import__(name)
        except ImportError:
            missing.append(name)
    if missing:
        die(
            "Missing Python packages: %s. Install them with: "
            "py -m pip install %s" % (", ".join(missing), " ".join(missing))
        )
    return mods


def cmd_check_mic(_args):
    mods = require_deps("sounddevice", "numpy")
    sd = mods["sounddevice"]
    np = mods["numpy"]

    devices = []
    try:
        for i, d in enumerate(sd.query_devices()):
            if d["max_input_channels"] > 0:
                devices.append({"index": i, "name": d["name"]})
    except Exception as exc:  # noqa: BLE001
        die("Could not list audio devices: %s" % exc)

    emit({"event": "mic-devices", "devices": devices})
    if not devices:
        die("No microphone found. Plug in a microphone and try again.")

    seconds = 3
    emit({"event": "mic-recording", "seconds": seconds,
          "message": "Recording 3 seconds — say something at normal volume."})
    try:
        rec = sd.rec(int(seconds * 16000), samplerate=16000, channels=1, dtype="int16")
        sd.wait()
    except Exception as exc:  # noqa: BLE001
        die("Microphone recording failed: %s" % exc)

    audio = rec.flatten().astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(audio ** 2)))
    peak = float(np.max(np.abs(audio)))
    ok = rms > 0.005
    emit({
        "event": "mic-result",
        "rms": round(rms, 4),
        "peak": round(peak, 4),
        "ok": ok,
        "message": ("Microphone is working." if ok
                    else "Microphone is very quiet — check Windows sound settings "
                           "and make sure the right input device is selected."),
    })


def cmd_listen(args):
    mods = require_deps("sounddevice", "numpy", "openwakeword")
    sd = mods["sounddevice"]
    np = mods["numpy"]

    from openwakeword.model import Model  # noqa: E402

    import os  # noqa: E402
    if not os.path.isfile(args.model):
        die(
            "Wake-word model file not found: %s. Train your \"Vira\" model first "
            "(see the VYRA wake-word setup guide), then copy vira.onnx to that path."
            % args.model
        )

    try:
        vad_kw = {"vad_threshold": args.vad_threshold} if args.vad_threshold > 0 else {}
        oww = Model(wakeword_models=[args.model], inference_framework="onnx",
                    **vad_kw)
    except Exception as exc:  # noqa: BLE001
        die("Could not load wake-word model: %s" % exc)

    try:
        stream = sd.InputStream(samplerate=16000, channels=1, dtype="int16",
                                blocksize=1280)
        stream.start()
    except Exception as exc:  # noqa: BLE001
        die("Could not open the microphone: %s. "
            "Check that a microphone is plugged in and not used by another app." % exc)

    emit({"event": "ready", "phrase": args.phrase, "sample_rate": 16000,
          "threshold": args.threshold})

    stt = None

    def transcribe(audio_f32):
        nonlocal stt
        if stt is None:
            fw = require_deps("faster_whisper")["faster_whisper"]
            # First run downloads the model once (~75-500 MB depending on
            # size); afterwards transcription is fully offline.
            stt = fw.WhisperModel(args.stt_model, device="cpu", compute_type="int8")
        segments, _info = stt.transcribe(audio_f32, beam_size=1, language="en",
                                        vad_filter=True)
        return " ".join(s.text.strip() for s in segments).strip()

    def rms_of(frames):
        if not frames:
            return 0.0
        a = np.concatenate(frames).astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(a ** 2)))

    VAD_THRESHOLD = 0.015
    END_SILENCE_S = 1.4
    MAX_COMMAND_S = 12.0

    def capture_command():
        """Record until the speaker pauses (or the cap), then transcribe."""
        frames = []
        silent_for = 0.0
        elapsed = 0.0
        frame_s = 1280 / 16000.0
        started_speech = False
        # Small pre-roll so the first syllable isn't clipped.
        while elapsed < MAX_COMMAND_S:
            data, _overflow = stream.read(1280)
            frames.append(data.flatten().copy())
            elapsed += frame_s
            if rms_of([frames[-1]]) > VAD_THRESHOLD:
                started_speech = True
                silent_for = 0.0
            elif started_speech:
                silent_for += frame_s
                if silent_for >= END_SILENCE_S and elapsed > 0.8:
                    break
        audio = np.concatenate(frames).astype(np.float32) / 32768.0
        if not started_speech or rms_of(frames) < 0.004:
            return ""
        try:
            return transcribe(audio)
        except Exception as exc:  # noqa: BLE001
            emit({"event": "error",
                  "message": "Command transcription failed: %s" % exc})
            return ""

    try:
        while True:
            data, _overflow = stream.read(1280)
            prediction = oww.predict(data.flatten())
            score = max(float(v) for v in prediction.values()) if prediction else 0.0
            if score >= args.threshold:
                emit({"event": "wake", "phrase": args.phrase,
                      "score": round(score, 3)})
                try:
                    oww.reset()
                except Exception:  # noqa: BLE001
                    pass
                text = capture_command()
                if text:
                    emit({"event": "command", "text": text})
                else:
                    emit({"event": "command-empty",
                          "message": "Heard the wake word but caught no command."})
                # Brief cooldown so one utterance can't double-trigger.
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            stream.stop()
            stream.close()
        except Exception:  # noqa: BLE001
            pass


def main():
    parser = argparse.ArgumentParser(description="VYRA offline wake-word listener")
    sub = parser.add_subparsers(dest="mode", required=True)

    p_listen = sub.add_parser("listen", help="run continuous wake-word detection")
    p_listen.add_argument("--model", required=True,
                          help="path to the trained openWakeWord .onnx model")
    p_listen.add_argument("--phrase", default="vira",
                          help="wake phrase the model was trained on")
    p_listen.add_argument("--threshold", type=float, default=0.5,
                          help="detection threshold 0..1 (default 0.5)")
    p_listen.add_argument("--stt-model", default="base.en",
                          help="faster-whisper model for commands "
                               "(tiny.en/base.en/small.en; downloaded once, then offline)")
    p_listen.add_argument("--vad-threshold", type=float, default=0.0,
                          help="silero voice-activity gate 0..1, 0 disables "
                               "(try 0.5 if background noise causes false wakes)")

    sub.add_parser("check-mic", help="verify the microphone works")

    args = parser.parse_args()
    if args.mode == "listen":
        cmd_listen(args)
    elif args.mode == "check-mic":
        cmd_check_mic(args)


if __name__ == "__main__":
    main()
