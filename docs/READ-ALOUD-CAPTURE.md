# Read Aloud capture

## Current ChatGPT behavior

The current ChatGPT web client handles one Read Aloud action with:

1. One `GET /backend-api/synthesize` request.
2. One `MediaSource` and one AAC `SourceBuffer`.
3. Repeated `appendBuffer()` calls fed from that response body.
4. One final Blob after the response reader reaches EOF and ChatGPT calls `endOfStream()`.

The client has no continuation cursor, byte-range request, or second synthesis request in this path. Playback ending is not a capture-completion signal. The complete synthesis response body may be available long before playback reaches the end, but it does not necessarily cover the complete assistant response.

The acceptance response contains 99,773 characters. ChatGPT's audio stops after `Original strategy notes.`, at character 50,402 and word 7,484. Another 7,474 words remain. The endpoint returned a valid finished AAC stream for that prefix and made no continuation request. This is an observed synthesis text limit near 50,000 characters, not a failed network capture.

## Completion rule

The extension clones the synthesis response without consuming or replacing ChatGPT's response. It stores each received chunk in IndexedDB. Network and `MediaSource` errors keep the session interrupted.

Response EOF proves that the audio file itself finished downloading. It does not prove that ChatGPT synthesized the full source message. When the selected assistant response exceeds the observed 50,000-character limit, the extension marks the result `Partial audio captured` and allows the captured part to be downloaded. It does not label that file as full audio.

For `audio/aac`, the extension parses every ADTS frame across network chunk boundaries. It verifies frame lengths and a stable codec configuration, then calculates duration from the AAC frame count. Compatible ADTS parts can be joined without rewriting their frame data. The extension refuses to join incompatible or containerized parts.

## Fixture result

The acceptance conversation's assistant response contains 14,958 words and 99,773 characters. The captured prefix contains 7,484 words. Its downloaded audio is:

- 23,717,082 bytes
- AAC-LC, 24 kHz, mono
- Exact decoded timeline: 52:28.885

The reference downloader names files with the local completion time. `ChatGPT_Audio_02-43-55.aac` means the download completed at 02:43:55. It does not claim a duration of 2:43:55.

`ffmpeg` decodes the beginning, middle, and final minute of that file without errors. The file is structurally complete but narrates only the first half of the source response. At the same speaking rate, the full 14,958-word response would last about 1:44:53.

## Diagnostics

Run this in the ChatGPT console before starting Read Aloud:

```js
localStorage.setItem("cgpt-ra-capture-debug", "1");
location.reload();
```

Diagnostics record synthesis request start and end times, bytes, headers, format verification, calculated audio duration, `MediaSource` lifecycle events, `SourceBuffer` MIME types, every `appendBuffer()` call, and audio duration, buffered, and seekable ranges. They do not record response audio bytes or authorization headers.
