import { formatOffset, parseZoneInfo } from "../impl/util.js";
import {
  isRangeError,
  normalizeTimeZoneId,
  offsetAt,
  resetOffsetCache,
} from "../impl/temporal.js";
import Zone from "../zone.js";

const ianaZoneCache = new Map();
const normalizedNameCache = new Map();

// Identifiers that are links to UTC in the IANA database. They normalize to "UTC", which is what
// Intl.DateTimeFormat#resolvedOptions() has historically reported for them.
const utcAliases = new Set([
  "utc",
  "etc/utc",
  "etc/uct",
  "etc/universal",
  "etc/zulu",
  "uct",
  "universal",
  "zulu",
  "gmt",
  "etc/gmt",
  "etc/gmt+0",
  "etc/gmt-0",
  "etc/gmt0",
  "etc/greenwich",
  "gmt+0",
  "gmt-0",
  "gmt0",
  "greenwich",
]);

/**
 * A zone identified by an IANA identifier, like America/New_York
 * @implements {Zone}
 */
export default class IANAZone extends Zone {
  /**
   * @param {string} name - Zone name
   * @return {IANAZone}
   */
  static create(name) {
    let zone = ianaZoneCache.get(name);
    if (zone === undefined) {
      ianaZoneCache.set(name, (zone = new IANAZone(name)));
    }
    return zone;
  }

  /**
   * Reset local caches. Should only be necessary in testing scenarios.
   * @return {void}
   */
  static resetCache() {
    ianaZoneCache.clear();
    normalizedNameCache.clear();
    resetOffsetCache();
  }

  /**
   * Returns whether the provided string is a valid specifier. This only checks the string's format, not that the specifier identifies a known zone; see isValidZone for that.
   * @param {string} s - The string to check validity on
   * @example IANAZone.isValidSpecifier("America/New_York") //=> true
   * @example IANAZone.isValidSpecifier("Sport~~blorp") //=> false
   * @deprecated For backward compatibility, this forwards to isValidZone, better use `isValidZone()` directly instead.
   * @return {boolean}
   */
  static isValidSpecifier(s) {
    return this.isValidZone(s);
  }

  /**
   * Returns whether the provided string identifies a real zone
   * @param {string} zone - The string to check
   * @example IANAZone.isValidZone("America/New_York") //=> true
   * @example IANAZone.isValidZone("Fantasia/Castle") //=> false
   * @example IANAZone.isValidZone("Sport~~blorp") //=> false
   * @return {boolean}
   */
  static isValidZone(zone) {
    return IANAZone.normalizeZone(zone) != null;
  }

  /**
   * Normalize the name of the provided IANA zone or return null
   * if it is not a valid IANA zone. Casing is normalized and aliases of UTC resolve to "UTC";
   * other link names are preserved as given.
   * @param {string} zone - The string to normalize
   * @example IANAZone.normalizeZone("America/New_York") //=> "America/New_York"
   * @example IANAZone.normalizeZone("america/NEw_York") //=> "America/New_York"
   * @example IANAZone.normalizeZone("Etc/GMT") //=> "UTC"
   * @example IANAZone.normalizeZone("Fantasia/Castle") //=> null
   * @example IANAZone.normalizeZone("Sport~~blorp") //=> null
   * @return {string|null}
   */
  static normalizeZone(zone) {
    if (!zone || typeof zone !== "string") {
      return null;
    }
    let normalized = normalizedNameCache.get(zone);
    if (normalized === undefined) {
      const id = normalizeTimeZoneId(zone);
      normalized = id === null ? null : utcAliases.has(id.toLowerCase()) ? "UTC" : id;
      normalizedNameCache.set(zone, normalized);
    }
    return normalized;
  }

  constructor(name) {
    super();
    const normalizedName = IANAZone.normalizeZone(name);
    /** @private **/
    this.valid = normalizedName != null;
    // For backwards compatibility we only normalize in casing, otherwise would also normalize something like
    // Etc/GMT to UTC.
    /** @private **/
    this.zoneName =
      normalizedName && normalizedName.toLowerCase() === name.toLowerCase() ? normalizedName : name;
  }

  /**
   * The type of zone. `iana` for all instances of `IANAZone`.
   * @override
   * @type {string}
   */
  get type() {
    return "iana";
  }

  /**
   * The name of this zone (i.e. the IANA zone name).
   * @override
   * @type {string}
   */
  get name() {
    return this.zoneName;
  }

  /**
   * Returns whether the offset is known to be fixed for the whole year:
   * Always returns false for all IANA zones.
   * @override
   * @type {boolean}
   */
  get isUniversal() {
    return false;
  }

  /**
   * Returns the offset's common name (such as EST) at the specified timestamp
   * @override
   * @param {number} ts - Epoch milliseconds for which to get the name
   * @param {Object} opts - Options to affect the format
   * @param {string} opts.format - What style of offset to return. Accepts 'long' or 'short'.
   * @param {string} opts.locale - What locale to return the offset name in.
   * @return {string}
   */
  offsetName(ts, { format, locale }) {
    return parseZoneInfo(ts, format, locale, this.name);
  }

  /**
   * Returns the offset's value as a string
   * @override
   * @param {number} ts - Epoch milliseconds for which to get the offset
   * @param {string} format - What style of offset to return.
   *                          Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
   * @return {string}
   */
  formatOffset(ts, format) {
    return formatOffset(this.offset(ts), format);
  }

  /**
   * Return the offset in minutes for this zone at the specified timestamp.
   * @override
   * @param {number} ts - Epoch milliseconds for which to compute the offset
   * @return {number}
   */
  offset(ts) {
    if (!this.valid || !Number.isFinite(ts)) return NaN;
    try {
      return offsetAt(this.zoneName, ts);
    } catch (e) {
      if (!isRangeError(e)) throw e;
      return NaN;
    }
  }

  /**
   * Return whether this Zone is equal to another zone
   * @override
   * @param {Zone} otherZone - the zone to compare
   * @return {boolean}
   */
  equals(otherZone) {
    return otherZone.type === "iana" && otherZone.name === this.name;
  }

  /**
   * Return whether this Zone is valid.
   * @override
   * @type {boolean}
   */
  get isValid() {
    return this.valid;
  }
}
