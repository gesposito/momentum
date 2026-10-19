import { ZoneIsAbstractError } from "./errors.js";
import type { ZoneOffsetFormat, ZoneOffsetOptions } from "./types.js";

/**
 * @interface
 */
export default class Zone {
  /**
   * The type of zone
   * @abstract
   */
  get type(): string {
    throw new ZoneIsAbstractError();
  }

  /**
   * The name of this zone.
   * @abstract
   */
  get name(): string {
    throw new ZoneIsAbstractError();
  }

  /**
   * The IANA name of this zone.
   * Defaults to `name` if not overwritten by a subclass.
   * @abstract
   */
  get ianaName(): string {
    return this.name;
  }

  /**
   * Returns whether the offset is known to be fixed for the whole year.
   * @abstract
   */
  get isUniversal(): boolean {
    throw new ZoneIsAbstractError();
  }

  /**
   * Returns the offset's common name (such as EST) at the specified timestamp
   * @abstract
   * @param ts - Epoch milliseconds for which to get the name
   * @param opts - Options to affect the format
   * @param opts.format - What style of offset to return. Accepts 'long' or 'short'.
   * @param opts.locale - What locale to return the offset name in.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  offsetName(ts: number, opts: ZoneOffsetOptions): string | null {
    throw new ZoneIsAbstractError();
  }

  /**
   * Returns the offset's value as a string
   * @abstract
   * @param ts - Epoch milliseconds for which to get the offset
   * @param format - What style of offset to return.
   *                 Accepts 'narrow', 'short', or 'techie'. Returning '+6', '+06:00', or '+0600' respectively
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  formatOffset(ts: number, format: ZoneOffsetFormat): string {
    throw new ZoneIsAbstractError();
  }

  /**
   * Return the offset in minutes for this zone at the specified timestamp.
   * @abstract
   * @param ts - Epoch milliseconds for which to compute the offset
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  offset(ts: number): number {
    throw new ZoneIsAbstractError();
  }

  /**
   * Return whether this Zone is equal to another zone
   * @abstract
   * @param otherZone - the zone to compare
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  equals(otherZone: Zone): boolean {
    throw new ZoneIsAbstractError();
  }

  /**
   * Return whether this Zone is valid.
   * @abstract
   */
  get isValid(): boolean {
    throw new ZoneIsAbstractError();
  }
}
