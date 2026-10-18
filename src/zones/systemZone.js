import { formatOffset, parseZoneInfo } from "../impl/util.js";
import { isRangeError, normalizeTimeZoneId, offsetAt, systemTimeZoneId } from "../impl/temporal.js";
import Zone from "../zone.js";

let singleton = null;
let systemZoneCache = null;

// The system zone's name as Temporal reports it, and the Temporal time zone that computes its
// offsets. Engines can report a name Temporal itself rejects (Node.js reports "Etc/Unknown" when
// TZ is empty); Luxon keeps such a name while `Date` computes in UTC, and so does momentum.
// Cached until Settings.resetCaches() is called.
function systemZoneInfo() {
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
export function systemZoneId() {
  return systemZoneInfo().id;
}

/**
 * @private
 */
export function resetSystemZoneCache() {
  systemZoneCache = null;
}

/**
 * Represents the local zone for this JavaScript environment.
 * @implements {Zone}
 */
export default class SystemZone extends Zone {
  /**
   * Get a singleton instance of the local zone
   * @return {SystemZone}
   */
  static get instance() {
    if (singleton === null) {
      singleton = new SystemZone();
    }
    return singleton;
  }

  /** @override **/
  get type() {
    return "system";
  }

  /** @override **/
  get name() {
    return systemZoneInfo().name;
  }

  /** @override **/
  get isUniversal() {
    return false;
  }

  /** @override **/
  offsetName(ts, { format, locale }) {
    return parseZoneInfo(ts, format, locale);
  }

  /** @override **/
  formatOffset(ts, format) {
    return formatOffset(this.offset(ts), format);
  }

  /** @override **/
  offset(ts) {
    if (!Number.isFinite(ts)) return NaN;
    try {
      return offsetAt(systemZoneId(), ts);
    } catch (e) {
      if (!isRangeError(e)) throw e;
      return NaN;
    }
  }

  /** @override **/
  equals(otherZone) {
    return otherZone.type === "system";
  }

  /** @override **/
  get isValid() {
    return true;
  }
}
