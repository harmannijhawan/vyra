# VYRA wake word setup (Windows)

Say **"Vira"** and VYRA starts listening. The next thing you say becomes a
real VYRA task. Everything runs on your PC — no account, no API key, no
cloud. Your microphone audio never leaves the machine.

This is a one-time setup, about 30–45 minutes, most of it waiting for
downloads and the model trainer. Do the steps in order. Every command
below is exact — copy and paste it as-is into a terminal (Command Prompt
or PowerShell both work).

---

## Step 1 — Install Python

```cmd
winget install Python.Python.3.11
```

Close the terminal and open a new one after it finishes, then check:

```cmd
py -3.11 --version
```

You should see `Python 3.11.x`. If you see an error, restart your PC once
and try again.

## Step 2 — Create the wake-word environment and install the packages

```cmd
py -3.11 -m venv C:\Users\user\.vyra\wakeword-venv
C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe -m pip install --upgrade pip
C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe -m pip install openwakeword sounddevice numpy faster-whisper
```

This takes a few minutes. Nothing here needs an account.

## Step 3 — Check your microphone

```cmd
cd C:\Users\user\Documents\vyra\apps\desktop\python
C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe vyra_wakeword.py check-mic
```

You should see a line containing `"event": "mic-ok"` and your
microphone's name. If you see `mic-error` instead:

1. Open Windows Settings → Privacy & security → Microphone.
2. Turn on **Microphone access** and **Let desktop apps access your microphone**.
3. Run the check again.

## Step 4 — Record your voice saying "Vira"

```cmd
C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe record_samples.py --phrase vira --count 15 --out wakeword-samples
```

Press Enter, then say "Vira" once, naturally — the way you'd actually say
it to your PC. Do this 15 times from a few different spots/distances.
These clips stay on your PC.

## Step 5 — Build your "Vira" model (one time, in your browser)

The open-source trainer builds the model from thousands of synthetic
voice variations — that's what makes it understand different accents,
including yours. Your recordings from step 4 are used in the next step
to prove it hears *you*.

1. Open this page (sign in with any free Google account — Colab needs one):
   <https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb?usp=sharing>
2. Type `vira` as the wake word and run all the cells. It takes under an
   hour on the free GPU.
3. Download the `vira.onnx` file it produces into your Downloads folder:
   `C:\Users\user\Downloads\vira.onnx`

## Step 6 — Prove the model hears YOUR voice

```cmd
C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe test_model.py --model C:\Users\user\Downloads\vira.onnx --clips wakeword-samples
```

It scores each of your 15 clips and tells you how many would wake VYRA
at sensitivities 0.5, 0.6 and 0.7, plus a suggested starting value.
Remember that number for step 9.

## Step 7 — Install the model where VYRA looks for it

```cmd
mkdir C:\Users\user\AppData\Roaming\VYRA\wakeword
copy C:\Users\user\Downloads\vira.onnx C:\Users\user\AppData\Roaming\VYRA\wakeword\vira.onnx
```

## Step 8 — Download the offline speech model (one time)

The first time VYRA transcribes a spoken command it needs this file
(~140 MB). Download it now so everything is offline afterwards:

```cmd
C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8')"
```

## Step 9 — Tell VYRA where everything is

1. Open VYRA → **Settings → Voice**.
2. Turn on **Wake word enabled**.
3. In **Wake-word Python (optional)**, paste exactly:
   `C:\Users\user\.vyra\wakeword-venv\Scripts\python.exe`
4. In **Wake-word sensitivity**, enter the number suggested in step 6
   (0.5 is the default if you skipped it).
5. Close and reopen VYRA.

## Step 10 — Try it

1. Say **"Vira"**. VYRA's activity feed shows `Heard "vira" — listening
   for your command.` and the orb switches to listening.
2. Say **"open Google"**. VYRA shows `Heard: "open Google"` and starts
   it as a real task, the same as typing it.

---

## If something doesn't work

- **"No trained model for vira yet"** in the activity feed → the
  `vira.onnx` file isn't in place. Redo step 7 and check the filename
  is exactly `vira.onnx`.
- **"Python 3 was not found"** → redo step 1, or paste the step-2 path
  into the **Wake-word Python** setting again.
- **VYRA wakes when you didn't say it** → raise **Wake-word sensitivity**
  to 0.6 or 0.7 in Settings → Voice, then restart VYRA.
- **VYRA misses you saying "Vira"** → lower **Wake-word sensitivity**
  to 0.4, and make sure you're speaking at normal volume toward the mic.
- **Nothing happens at all** → say it once and check the activity feed:
  VYRA reports listener problems there in plain words instead of failing
  silently.

To turn the listener off any time: Settings → Voice → turn off **Wake
word enabled**. VYRA releases the microphone immediately.
