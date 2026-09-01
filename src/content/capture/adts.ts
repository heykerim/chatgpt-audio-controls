const SAMPLE_RATES = [
  96000,
  88200,
  64000,
  48000,
  44100,
  32000,
  24000,
  22050,
  16000,
  12000,
  11025,
  8000,
  7350,
] as const;

export interface AdtsInspection {
  valid: boolean;
  frameCount: number;
  durationSeconds: number | null;
  sampleRate: number | null;
  channelCount: number | null;
  audioObjectType: number | null;
  signature: string | null;
  error: string | null;
}

function invalid(error: string, frameCount = 0): AdtsInspection {
  return {
    valid: false,
    frameCount,
    durationSeconds: null,
    sampleRate: null,
    channelCount: null,
    audioObjectType: null,
    signature: null,
    error,
  };
}

function appendBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  if (!left.length) return right;
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

export function inspectAdts(chunks: readonly Uint8Array[]): AdtsInspection {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let frameCount = 0;
  let totalSamples = 0;
  let expectedSignature: string | null = null;
  let sampleRate: number | null = null;
  let channelCount: number | null = null;
  let audioObjectType: number | null = null;

  for (const chunk of chunks) {
    if (!chunk.byteLength) continue;
    pending = appendBytes(pending, chunk);
    let offset = 0;

    while (pending.length - offset >= 7) {
      const byte1 = pending[offset + 1];
      if (pending[offset] !== 0xff || (byte1 & 0xf6) !== 0xf0) {
        return invalid(`Invalid ADTS sync word at byte ${offset}.`, frameCount);
      }

      const protectionAbsent = (byte1 & 1) === 1;
      const headerLength = protectionAbsent ? 7 : 9;
      if (pending.length - offset < headerLength) break;

      const byte2 = pending[offset + 2];
      const byte3 = pending[offset + 3];
      const byte4 = pending[offset + 4];
      const byte5 = pending[offset + 5];
      const byte6 = pending[offset + 6];
      const sampleRateIndex = (byte2 >> 2) & 0x0f;
      const currentSampleRate = SAMPLE_RATES[sampleRateIndex];
      if (!currentSampleRate) return invalid(`Unsupported ADTS sample-rate index ${sampleRateIndex}.`, frameCount);

      const currentAudioObjectType = ((byte2 >> 6) & 3) + 1;
      const currentChannelCount = ((byte2 & 1) << 2) | ((byte3 >> 6) & 3);
      const frameLength = ((byte3 & 3) << 11) | (byte4 << 3) | ((byte5 >> 5) & 7);
      if (frameLength < headerLength) return invalid(`Invalid ADTS frame length ${frameLength}.`, frameCount);
      if (pending.length - offset < frameLength) break;

      const mpegVersion = (byte1 >> 3) & 1;
      const signature = `${mpegVersion}:${currentAudioObjectType}:${currentSampleRate}:${currentChannelCount}`;
      if (expectedSignature && signature !== expectedSignature) {
        return invalid(`ADTS codec changed from ${expectedSignature} to ${signature}.`, frameCount);
      }

      expectedSignature = signature;
      sampleRate = currentSampleRate;
      channelCount = currentChannelCount;
      audioObjectType = currentAudioObjectType;
      totalSamples += 1024 * ((byte6 & 3) + 1);
      frameCount += 1;
      offset += frameLength;
    }

    pending = pending.slice(offset);
  }

  if (!frameCount) return invalid("No complete ADTS frames were found.");
  if (pending.length) return invalid(`The ADTS stream ended with ${pending.length} truncated byte(s).`, frameCount);

  return {
    valid: true,
    frameCount,
    durationSeconds: totalSamples / (sampleRate as number),
    sampleRate,
    channelCount,
    audioObjectType,
    signature: expectedSignature,
    error: null,
  };
}
