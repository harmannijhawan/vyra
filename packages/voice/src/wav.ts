/**
 * Minimal WAV (RIFF) encode/decode helpers for 16-bit PCM audio.
 *
 * Used to ship captured microphone audio to STT HTTP APIs that expect a
 * `.wav` upload, and to turn `audio/wav` TTS responses back into raw PCM.
 * Only PCM, 16-bit, mono/stereo is supported — anything else throws.
 */

export interface DecodedWav {
  pcm: Int16Array;
  sampleRate: number;
  channels: number;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Encode 16-bit PCM samples as a WAV file. */
export function encodeWav(
  pcm: Int16Array,
  sampleRate: number,
  channels = 1,
): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  new Int16Array(buffer, 44, pcm.length).set(pcm);
  return new Uint8Array(buffer);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

/** Decode a WAV file's PCM payload. Throws on non-PCM-16-bit input. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 44) throw new Error('decodeWav: input too short to be a WAV file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('decodeWav: not a RIFF/WAVE file');
  }

  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ') {
      const format = view.getUint16(offset + 8, true);
      if (format !== 1) {
        throw new Error(`decodeWav: unsupported WAV format ${format} (only PCM)`);
      }
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      if (bitsPerSample !== 16) {
        throw new Error(`decodeWav: unsupported bit depth ${bitsPerSample} (only 16-bit)`);
      }
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataLength = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error('decodeWav: no data chunk found');
  if (sampleRate <= 0) throw new Error('decodeWav: missing fmt chunk');

  const sampleCount = Math.floor(dataLength / 2);
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(dataOffset + i * 2, true);
  }
  return { pcm, sampleRate, channels };
}
