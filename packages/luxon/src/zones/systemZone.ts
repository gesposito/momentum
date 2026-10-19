import { formatOffset, parseZoneInfo } from "../impl/util.js";
import { isRangeError, normalizeTimeZoneId, offsetAt, systemTimeZoneId } from "../impl/temporal.js";
import Zone from "../zone.js";
import type { ZoneOffsetFormat, ZoneOffsetOptions } from "../types.js";

let singleton: SystemZone | null = null;
let systemZoneCache: { name: string; id: string } | null = null;

// The system zone's name as Temporal reports it, and the Temporal time zone that computes its
// offsets. Engines can report a name Temporal itself rejects (Node.js reports "Etc/Unknown" when
// TZ is empty); Luxon keeps such a name while `Date` computes in UTC, and so does momentum.
// Cached until Settings.resetCaches() is called.
function systemZoneInfo(): { name: string; id: string } {
  if (systemZoneCache === null) {
    const name = systemTimeZoneId();
    systemZoneCache = { name, id: normalizeTimeZoneId(name) ?? "UTC" };
  }
  return systemZoneCache;
}

/**
 * Identifier of the Temporal time zone that computes the system zone's offsets.
 * @private
 */
export function systemZoneId(): string {
  return systemZoneInfo().id;
}

/**
 * @private
 */
export function resetSystemZoneCache(): void {
  systemZoneCache = null;
}

/**
 * Represents the local zone for this JavaScript environment.
 * @implements {Zone}
 */
export default class SystemZone extends Zone {
  /**
   * Get a singleton instance of the local zone
   */
  static get instance(): SystemZone {
    if (singleton === null) {
      singleton = new SystemZone();
    }
    return singleton;
  }

  override get type(): string {
    return "system";
  }

  override get name(): string {
    return systemZoneInfo().name;
  }

  override get isUniversal(): boolean {
    return false;
  }

  override offsetName(ts: number, { format, locale }: ZoneOffsetOptions): string | null {
    return parseZoneInfo(ts, format, locale);
  }

  override formatOffset(ts: number, format: ZoneOffsetFormat): string {
    return formatOffset(this.offset(ts), format);
  }

  override offset(ts: number): number {
    if (!Number.isFinite(ts)) return NaN;
    try {
      return offsetAt(systemZoneId(), ts);
    } catch (e) {
      if (!isRangeError(e)) throw e;
      return NaN;
    }
  }

  override equals(otherZone: Zone): boolean {
    return otherZone.type === "system";
  }

  override get isValid(): boolean {
    return true;
  }
}
