import { DEFAULT_SETTINGS, SETTING_STORAGE_KEYS, STORAGE_KEYS } from "../shared/constants";
import { ExtensionSettings } from "../shared/types";

const BRIDGE_SOURCE = "chatgpt-audio-controls-settings-bridge";
const REQUEST_TYPE = "CGPT_RA_SETTINGS_REQUEST";
const UPDATE_TYPE = "CGPT_RA_SETTINGS_UPDATE";
const THEME_UPDATE_TYPE = "CGPT_RA_THEME_UPDATE";
const CAPTURE_SOURCE = "chatgpt-audio-controls-capture";
const CAPTURE_UPDATE_TYPE = "CGPT_RA_CAPTURE_UPDATE";
const CAPTURE_DIAGNOSTICS_UPDATE_TYPE = "CGPT_RA_CAPTURE_DIAGNOSTICS_UPDATE";
const CHATGPT_THEME_KEYS = new Set(["blue", "green", "purple", "orange", "pink", "yellow", "black"]);
const settingEntries = Object.entries(SETTING_STORAGE_KEYS) as [keyof ExtensionSettings, string][];
const settingStorageKeyNames = settingEntries.map(([, storageKey]) => storageKey);
let pendingDiagnostics: unknown[] | null = null;
let diagnosticsWriteTimer: number | null = null;

function queueDiagnosticsWrite(events: unknown[]): void {
  pendingDiagnostics = events;
  if (diagnosticsWriteTimer !== null) return;
  diagnosticsWriteTimer = window.setTimeout(() => {
    diagnosticsWriteTimer = null;
    const next = pendingDiagnostics;
    pendingDiagnostics = null;
    if (next) void chrome.storage.local.set({ "cgpt-ra-capture-diagnostics": next });
  }, 500);
}

function getStoredSettings(data: Record<string, unknown>): ExtensionSettings {
  const legacySettings = data[STORAGE_KEYS.SETTINGS];
  const flatSettings = Object.fromEntries(
    settingEntries
      .filter(([, storageKey]) => data[storageKey] !== undefined)
      .map(([settingName, storageKey]) => [settingName, data[storageKey]]),
  );

  return {
    ...DEFAULT_SETTINGS,
    ...(legacySettings && typeof legacySettings === "object" ? legacySettings : {}),
    ...flatSettings,
  } as ExtensionSettings;
}

function publish(settings: ExtensionSettings): void {
  window.postMessage(
    {
      source: BRIDGE_SOURCE,
      type: UPDATE_TYPE,
      settings,
    },
    "*",
  );
}

async function readSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.sync.get([STORAGE_KEYS.SETTINGS, ...settingStorageKeyNames]);
    publish(getStoredSettings(stored));
  } catch (_) {
    publish(DEFAULT_SETTINGS);
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  if (
    event.source === window &&
    event.data?.source === BRIDGE_SOURCE &&
    event.data?.type === REQUEST_TYPE
  ) {
    void readSettings();
  }

  if (
    event.source === window &&
    event.data?.source === BRIDGE_SOURCE &&
    event.data?.type === THEME_UPDATE_TYPE &&
    event.data?.theme &&
    CHATGPT_THEME_KEYS.has(event.data.theme.chatTheme) &&
    typeof event.data.theme.isDark === "boolean" &&
    typeof event.data.theme.updatedAt === "number"
  ) {
    void chrome.storage.local.set({ "cgpt-ra-theme-cache": event.data.theme });
  }

  if (
    event.source === window &&
    event.data?.source === CAPTURE_SOURCE &&
    event.data?.type === CAPTURE_UPDATE_TYPE &&
    Array.isArray(event.data.sessions)
  ) {
    void chrome.storage.local.set({ "cgpt-ra-capture-state": event.data.sessions });
  }

  if (
    event.source === window &&
    event.data?.source === CAPTURE_SOURCE &&
    event.data?.type === CAPTURE_DIAGNOSTICS_UPDATE_TYPE &&
    Array.isArray(event.data.events)
  ) {
    queueDiagnosticsWrite(event.data.events);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CGPT_RA_CAPTURE_LIST") {
    const requestId = crypto.randomUUID();
    const listener = (event: MessageEvent) => {
      if (
        event.source === window &&
        event.data?.source === CAPTURE_SOURCE &&
        event.data?.type === "CGPT_RA_CAPTURE_LIST_RESPONSE" &&
        event.data?.requestId === requestId
      ) {
        window.removeEventListener("message", listener);
        sendResponse({ sessions: event.data.sessions });
      }
    };
    window.addEventListener("message", listener);
    window.postMessage({ source: CAPTURE_SOURCE, type: "CGPT_RA_CAPTURE_LIST_REQUEST", requestId }, "*");
    window.setTimeout(() => window.removeEventListener("message", listener), 1_500);
    return true;
  }

  if (message?.type === "CGPT_RA_CAPTURE_DOWNLOAD" && typeof message.sessionId === "string") {
    window.postMessage({ source: CAPTURE_SOURCE, type: "CGPT_RA_CAPTURE_DOWNLOAD_REQUEST", sessionId: message.sessionId }, "*");
    sendResponse({ ok: true });
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  if (
    !changes[STORAGE_KEYS.SETTINGS] &&
    !settingStorageKeyNames.some((storageKey) => changes[storageKey])
  ) return;

  void readSettings();
});

void readSettings();
