import { formatOffset, signedOffset } from "../impl/util.js";
import Zone from "../zone.js";
import type { ZoneOffsetFormat } from "../types.js";

let singleton: FixedOffsetZone | null = null;

/**
 * A zone with a fixed offset (meaning no DST)
 * @implements {Zone}
 */
export default class FixedOffsetZone extends Zone {
  /**
   * Get a singleton instance of UTC
   */
  static get utcInstance(): FixedOffsetZone {
    if (singleton === null) {
      singleton = new FixedOffsetZone(0);
    }
    return singleton;
  }

  /**
   * Get an instance with a specified offset
   * @param offset - The offset in minutes
   */
  static instance(offset: number): FixedOffsetZone {
    return offset === 0 ? FixedOffsetZone.utcInstance : new FixedOffsetZone(offset);
  }

  /**
   * Get an instance of FixedOffsetZone from a UTC offset string, like "UTC+6"
   * @param s - The offset string to parse
   * @example FixedOffsetZone.parseSpecifier("UTC+6")
   * @example FixedOffsetZone.parseSpecifier("UTC+06")
   * @example FixedOffsetZone.parseSpecifier("UTC-6:00")
   */
  static parseSpecifier(s: string | null | undefined): FixedOffsetZone | null {
    if (s) {
      const r = s.match(/^utc(?:([+-]\d{1,2})(?::(\d{2}))?)?$/i);
      if (r) {
        return new FixedOffsetZone(signedOffset(r[1], r[2]));
      }
    }
    return null;
  }

  /** The fixed offset in minutes. @internal */
  readonly fixed: number;
  private readonly valid: boolean;

  constructor(offset: number) {
    super();
    this.fixed = offset;
    this.valid = Number.isInteger(offset);
  }

  /**
   * The type of zone. `fixed` for all instances of `FixedOffsetZone`.
   */
  override get type(): string {
    return "fixed";
  }

  /**
   * The name of this zone.
   * All fixed zones' names always start with "UTC" (plus optional offset)
   */
  override get name(): string {
    return this.fixed === 0 ? "UTC" : `UTC${formatOffset(this.fixed, "narrow")}`;
  }

  /**
   * The IANA name of this zone, i.e. `Etc/UTC` or `Etc/GMT+/-nn`
   */
  override get ianaName(): string {
    if (this.fixed === 0) {
      return "Etc/UTC";
    } else {
      return `Etc/GMT${formatOffset(-this.fixed, "narrow")}`;
    }
  }

  /**
   * Returns the offset's common name at the specified timestamp.
   *
   * For fixed offset zones this equals to the zone name.
   */
  override offsetName(): string {
    return this.name;
  }

  /**
   * Returns the offset's value as a string
   * @param ts - Epoch milliseconds for which to get the offset
   * @param format - What style of offset to return.
   *                 Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
   */
  override formatOffset(ts: number, format: ZoneOffsetFormat): string {
    return formatOffset(this.fixed, format);
  }

  /**
   * Returns whether the offset is known to be fixed for the whole year:
   * Always returns true for all fixed offset zones.
   */
  override get isUniversal(): boolean {
    return true;
  }

  /**
   * Return the offset in minutes for this zone at the specified timestamp.
   *
   * For fixed offset zones, this is constant and does not depend on a timestamp.
   */
  override offset(): number {
    return this.fixed;
  }

  /**
   * Return whether this Zone is equal to another zone (i.e. also fixed and same offset)
   * @param otherZone - the zone to compare
   */
  override equals(otherZone: Zone): boolean {
    return otherZone.type === "fixed" && (otherZone as FixedOffsetZone).fixed === this.fixed;
  }

  /**
   * Return whether this Zone is valid:
   * All fixed offset zones are valid, provided they were constructed with a numeric offset.
   */
  override get isValid(): boolean {
    return this.valid;
  }
}
