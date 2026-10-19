/*
  Which core computes DateTimes (see Settings.temporalNative): Temporal objects, the default, or
  Luxon's own algorithms fed with Temporal's offsets. The flag lives apart from Settings so that
  the modules on both sides of the choice can read it without importing DateTime.
*/

let temporalNative = true;

export function isTemporalNative(): boolean {
  return temporalNative;
}

export function setTemporalNative(value: boolean): void {
  temporalNative = value;
}
