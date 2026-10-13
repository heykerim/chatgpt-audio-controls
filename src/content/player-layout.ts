export type PlayerLayoutMode = "collapsed" | "side" | "above";

export function displayedAudioDuration(mediaDuration: number, capturedDuration: number | null): number {
  const media = Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0;
  const captured = capturedDuration !== null && Number.isFinite(capturedDuration) && capturedDuration > 0
    ? capturedDuration
    : 0;
  return Math.max(media, captured);
}

export function playerLayoutMode(input: {
  forcedCollapsed: boolean;
  forcedExpand: boolean;
  activeAudio: boolean;
  leftAvailable: number;
  rightAvailable: number;
  minLeftWidth: number;
  minRightWidth: number;
}): PlayerLayoutMode {
  const shouldExpand = !input.forcedCollapsed && (input.activeAudio || input.forcedExpand);
  if (!shouldExpand) return "collapsed";
  const canFitAtSides = input.leftAvailable >= input.minLeftWidth && input.rightAvailable >= input.minRightWidth;
  return canFitAtSides ? "side" : "above";
}
