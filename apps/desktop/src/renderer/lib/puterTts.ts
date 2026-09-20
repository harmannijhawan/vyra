/**
 * Puter-powered text-to-speech — real ElevenLabs voices with no API key.
 *
 * Uses the official Puter.js SDK (https://developer.puter.com/tutorials/free-unlimited-elevenlabs-api/).
 * The call is keyless from VYRA's side: usage is covered by the user's own
 * Puter account under Puter's user-pays model. On first use Puter may ask the
 * user to sign in — the main process allows the puter.com auth popup for
 * exactly that and nothing else.
 *
 * Honesty rule: every function here either produces real ElevenLabs audio or
 * throws. There is no fallback beep, no fake speech.
 */

export const PUTER_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs "Rachel"
const PUTER_MODEL = 'eleven_flash_v2_5'; // fast, good quality
const MAX_CHARS = 2500; // Puter caps synthesis text below 3000 chars; stay under it.

interface Txt2SpeechOptions {
  provider?: string;
  voice?: string;
  model?: string;
  language?: string;
}

let current: HTMLAudioElement | null = null;
let currentDone: (() => void) | null = null;

/**
 * Strip markdown / code / links so VYRA doesn't read formatting syntax aloud.
 * Pure function — unit tested.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g, '$1') // links -> text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/[*_~]{1,3}([^ *_~][^*_~]*?)[*_~]{1,3}/g, '$1') // emphasis
    .replace(/<[^>]+>/g, ' ') // html tags
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

async function loadPuter(): Promise<{
  ai: { txt2speech: (text: string, options: Txt2SpeechOptions) => Promise<HTMLAudioElement> };
}> {
  // Dynamic import: puter.js is only fetched when speech is actually used,
  // and the SDK stays out of the initial bundle.
  const mod = (await import('@heyputer/puter.js')) as {
    puter: {
      ai: { txt2speech: (text: string, options: Txt2SpeechOptions) => Promise<HTMLAudioElement> };
    };
  };
  return mod.puter;
}

export function isPuterSpeechActive(): boolean {
  return current !== null;
}

/** Stop any in-flight Puter speech immediately (barge-in / interrupt). */
export function stopPuterSpeech(): void {
  const audio = current;
  const done = currentDone;
  current = null;
  currentDone = null;
  if (audio) {
    try {
      audio.pause();
    } catch {
      // Best-effort: a failing pause must not break interruption.
    }
  }
  done?.();
}

/**
 * Speak text with an ElevenLabs voice via Puter. Resolves when playback
 * finishes; rejects when synthesis or playback genuinely fails. A new call
 * always interrupts the previous utterance.
 */
export async function speakWithPuter(rawText: string, opts?: { voiceId?: string }): Promise<void> {
  const text = sanitizeForSpeech(rawText);
  if (!text) return;
  stopPuterSpeech();

  const puter = await loadPuter();
  const audio = await puter.ai.txt2speech(text, {
    provider: 'elevenlabs',
    voice: opts?.voiceId ?? PUTER_ELEVENLABS_VOICE,
    model: PUTER_MODEL,
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      if (current === audio) {
        current = null;
        currentDone = null;
      }
    };
    const onEnded = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('[VYRA TTS] Puter audio playback failed.'));
    };
    current = audio;
    currentDone = onEnded;
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    try {
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch((err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            err instanceof Error ? err : new Error('[VYRA TTS] Puter audio playback was blocked.'),
          );
        });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error('[VYRA TTS] Puter audio playback failed.'));
      }
    }
  });
}
