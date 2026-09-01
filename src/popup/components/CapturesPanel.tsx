import React, { useEffect, useState } from "react";

type CapturePart = { extension: string; receivedBytes: number };
type CaptureSession = {
  id: string;
  title: string;
  state: "receiving" | "waiting" | "complete" | "interrupted";
  receivedBytes: number;
  partCount: number;
  canDownload: boolean;
  parts: CapturePart[];
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(mb >= 100 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function status(session: CaptureSession): string {
  if (session.state === "receiving") return "Receiving…";
  if (session.state === "waiting") return "Waiting for next audio part";
  if (session.state === "interrupted") return "Capture interrupted";
  return session.canDownload ? "Ready" : "Captured parts need remuxing";
}

export const CapturesPanel: React.FC = () => {
  const [sessions, setSessions] = useState<CaptureSession[]>([]);

  const refresh = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id || !tab.url?.startsWith("https://chatgpt.com/")) {
        setSessions([]);
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: "CGPT_RA_CAPTURE_LIST" }, (response) => {
        if (chrome.runtime.lastError) return setSessions([]);
        setSessions(Array.isArray(response?.sessions) ? response.sessions : []);
      });
    });
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 1_500);
    return () => window.clearInterval(timer);
  }, []);

  const download = (sessionId: string) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "CGPT_RA_CAPTURE_DOWNLOAD", sessionId });
    });
  };

  return (
    <section className="captures-panel" aria-label="Read Aloud captures">
      <div className="captures-heading">Read Aloud captures</div>
      {!sessions.length ? (
        <p className="captures-empty">No Read Aloud audio captured yet. Start Read Aloud on a ChatGPT response to begin capturing it.</p>
      ) : sessions.map((session) => (
        <div className="capture-item" key={session.id}>
          <div className="capture-copy">
            <strong>{session.title}</strong>
            <span>{formatBytes(session.receivedBytes)}{session.partCount > 1 ? ` • ${session.partCount} parts` : ""} • {status(session)}</span>
          </div>
          <button disabled={session.state !== "complete" || !session.canDownload} onClick={() => download(session.id)}>
            Download
          </button>
        </div>
      ))}
    </section>
  );
};
