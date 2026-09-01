# Read Aloud capture

## Current ChatGPT behavior

The current ChatGPT web client handles one Read Aloud action with:

1. One `GET /backend-api/synthesize` request.
2. One `MediaSource` and one AAC `SourceBuffer`.
3. Repeated `appendBuffer()` calls fed from that response body.
4. One final Blob after the response reader reaches EOF and ChatGPT calls `endOfStream()`.

The client has no continuation cursor, byte-range request, or second synthesis request in this path. Playback ending is not a capture-completion signal. The complete response body may be available long before playback reaches the end.

## Completion rule

The extension clones the synthesis response without consuming or replacing ChatGPT's response. It stores each received chunk in IndexedDB. A capture becomes complete only when the cloned response reaches EOF. Network and `MediaSource` errors keep the session interrupted and disable the full-audio download.

For `audio/aac`, the extension parses every ADTS frame across network chunk boundaries. It verifies frame lengths and a stable codec configuration, then calculates duration from the AAC frame count. Compatible ADTS parts can be joined without rewriting their frame data. The extension refuses to join incompatible or containerized parts.

## Fixture result

The acceptance conversation's last assistant response contains about 7,744 words. Its successful reference download is:

- 23,491,813 bytes
- AAC-LC, 24 kHz, mono
- 73,262 ADTS frames
- Exact decoded timeline: 52:05.845

The reference downloader names files with the local completion time. `ChatGPT_Audio_02-43-55.aac` means the download completed at 02:43:55. It does not claim a duration of 2:43:55.

`ffmpeg` decodes the beginning, middle, and final minute of that file without errors. The extension's ADTS parser also accepts the complete file and reports the exact 52:05.845 timeline.

## Diagnostics

Run this in the ChatGPT console before starting Read Aloud:

```js
localStorage.setItem("cgpt-ra-capture-debug", "1");
location.reload();
```

Diagnostics record synthesis request start and end times, bytes, headers, format verification, calculated audio duration, `MediaSource` lifecycle events, `SourceBuffer` MIME types, every `appendBuffer()` call, and audio duration, buffered, and seekable ranges. They do not record response audio bytes or authorization headers.
