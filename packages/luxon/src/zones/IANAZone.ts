import { formatOffset, parseZoneInfo } from "../impl/util.js";
import {
  isRangeError,
  normalizeTimeZoneId,
  offsetAt,
  resetOffsetCache,
} from "../impl/temporal.js";
import Zone from "../zone.js";
import type { ZoneOffsetFormat, ZoneOffsetOptions } from "../types.js";

const ianaZoneCache = /* @__PURE__ */ new Map<string, IANAZone>();
const normalizedNameCache = /* @__PURE__ */ new Map<string, string | null>();

// Identifiers that are links to UTC in the IANA database. They normalize to "UTC", which is what
// Intl.DateTimeFormat#resolvedOptions() has historically reported for them.
const utcAliases = /* @__PURE__ */ new Set([
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
   * @param name - Zone name
   */
  static create(name: string): IANAZone {
    let zone = ianaZoneCache.get(name);
    if (zone === undefined) {
      ianaZoneCache.set(name, (zone = new IANAZone(name)));
    }
    return zone;
  }

  /**
   * Reset local caches. Should only be necessary in testing scenarios.
   */
  static resetCache(): void {
    ianaZoneCache.clear();
    normalizedNameCache.clear();
    resetOffsetCache();
  }

  /**
   * Returns whether the provided string is a valid specifier. This only checks the string's format, not that the specifier identifies a known zone; see isValidZone for that.
   * @param s - The string to check validity on
   * @example IANAZone.isValidSpecifier("America/New_York") //=> true
   * @example IANAZone.isValidSpecifier("Sport~~blorp") //=> false
   * @deprecated For backward compatibility, this forwards to isValidZone, better use `isValidZone()` directly instead.
   */
  static isValidSpecifier(s: string | null | undefined): boolean {
    return this.isValidZone(s);
  }

  /**
   * Returns whether the provided string identifies a real zone
   * @param zone - The string to check
   * @example IANAZone.isValidZone("America/New_York") //=> true
   * @example IANAZone.isValidZone("Fantasia/Castle") //=> false
   * @example IANAZone.isValidZone("Sport~~blorp") //=> false
   */
  static isValidZone(zone: unknown): boolean {
    return IANAZone.normalizeZone(zone) != null;
  }

  /**
   * Normalize the name of the provided IANA zone or return null
   * if it is not a valid IANA zone. Casing is normalized and aliases of UTC resolve to "UTC";
   * other link names are preserved as given.
   * @param zone - The string to normalize
   * @example IANAZone.normalizeZone("America/New_York") //=> "America/New_York"
   * @example IANAZone.normalizeZone("america/NEw_York") //=> "America/New_York"
   * @example IANAZone.normalizeZone("Etc/GMT") //=> "UTC"
   * @example IANAZone.normalizeZone("Fantasia/Castle") //=> null
   * @example IANAZone.normalizeZone("Sport~~blorp") //=> null
   */
  static normalizeZone(zone: unknown): string | null {
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

  private readonly valid: boolean;
  private readonly zoneName: string;

  constructor(name: string) {
    super();
    const normalizedName = IANAZone.normalizeZone(name);
    this.valid = normalizedName != null;
    // For backwards compatibility we only normalize in casing, otherwise would also normalize something like
    // Etc/GMT to UTC.
    this.zoneName =
      normalizedName && normalizedName.toLowerCase() === name.toLowerCase() ? normalizedName : name;
  }

  /**
   * The type of zone. `iana` for all instances of `IANAZone`.
   */
  override get type(): string {
    return "iana";
  }

  /**
   * The name of this zone (i.e. the IANA zone name).
   */
  override get name(): string {
    return this.zoneName;
  }

  /**
   * Returns whether the offset is known to be fixed for the whole year:
   * Always returns false for all IANA zones.
   */
  override get isUniversal(): boolean {
    return false;
  }

  /**
   * Returns the offset's common name (such as EST) at the specified timestamp
   * @param ts - Epoch milliseconds for which to get the name
   * @param opts - Options to affect the format
   * @param opts.format - What style of offset to return. Accepts 'long' or 'short'.
   * @param opts.locale - What locale to return the offset name in.
   */
  override offsetName(ts: number, { format, locale }: ZoneOffsetOptions): string | null {
    return parseZoneInfo(ts, format, locale, this.name);
  }

  /**
   * Returns the offset's value as a string
   * @param ts - Epoch milliseconds for which to get the offset
   * @param format - What style of offset to return.
   *                 Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
   */
  override formatOffset(ts: number, format: ZoneOffsetFormat): string {
    return formatOffset(this.offset(ts), format);
  }

  /**
   * Return the offset in minutes for this zone at the specified timestamp.
   * @param ts - Epoch milliseconds for which to compute the offset
   */
  override offset(ts: number): number {
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
   * @param otherZone - the zone to compare
   */
  override equals(otherZone: Zone): boolean {
    return otherZone.type === "iana" && otherZone.name === this.name;
  }

  /**
   * Return whether this Zone is valid.
   */
  override get isValid(): boolean {
    return this.valid;
  }
}
