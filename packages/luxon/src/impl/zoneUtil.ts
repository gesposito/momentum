/**
 * @private
 */

import Zone from "../zone.js";
import IANAZone from "../zones/IANAZone.js";
import FixedOffsetZone from "../zones/fixedOffsetZone.js";
import InvalidZone from "../zones/invalidZone.js";
import SystemZone, { systemZoneId } from "../zones/systemZone.js";

import { isUndefined, isString, isNumber } from "./util.js";
import { offsetTimeZoneId } from "./temporal.js";
import type { ZoneLike } from "../types.js";

export function normalizeZone(input: ZoneLike | unknown, defaultZone: Zone): Zone {
  if (isUndefined(input) || input === null) {
    return defaultZone;
  } else if (input instanceof Zone) {
    return input;
  } else if (isString(input)) {
    const lowered = input.toLowerCase();
    if (lowered === "default") return defaultZone;
    else if (lowered === "local" || lowered === "system") return SystemZone.instance;
    else if (lowered === "utc" || lowered === "gmt") return FixedOffsetZone.utcInstance;
    else return FixedOffsetZone.parseSpecifier(lowered) || IANAZone.create(input);
  } else if (isNumber(input)) {
    return FixedOffsetZone.instance(input);
  } else if (
    typeof input === "object" &&
    "offset" in input &&
    typeof (input as { offset: unknown }).offset === "function"
  ) {
    // This is dumb, but the instanceof check above doesn't seem to really work
    // so we're duck checking it
    return input as Zone;
  } else {
    return new InvalidZone(input as string);
  }
}

/**
 * The Temporal time zone identifier that represents a built-in zone, or null when there is none:
 * custom zones only expose offsets through `Zone#offset()`, and Temporal's offset time zones are
 * whole minutes under a day.
 */
export function temporalZoneId(zone: Zone): string | null {
  switch (zone.type) {
    case "iana":
      return zone.name;
    case "fixed": {
      const offset = (zone as FixedOffsetZone).fixed;
      return offset === 0 ? "UTC" : offsetTimeZoneId(offset);
    }
    case "system":
      return systemZoneId();
    default:
      return null;
  }
}
