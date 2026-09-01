export type PlayerLayoutMode = "collapsed" | "side" | "above";

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
