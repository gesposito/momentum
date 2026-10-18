// these aren't really private, but nor are they really useful to document

/**
 * @private
 */
class LuxonError extends Error {}

/**
 * @private
 */
export class InvalidDateTimeError extends LuxonError {
  constructor(reason) {
    super(`Invalid DateTime: ${reason.toMessage()}`);
  }
}

/**
 * @private
 */
export class InvalidIntervalError extends LuxonError {
  constructor(reason) {
    super(`Invalid Interval: ${reason.toMessage()}`);
  }
}

/**
 * @private
 */
export class InvalidDurationError extends LuxonError {
  constructor(reason) {
    super(`Invalid Duration: ${reason.toMessage()}`);
  }
}

/**
 * @private
 */
export class ConflictingSpecificationError extends LuxonError {}

/**
 * @private
 */
export class InvalidUnitError extends LuxonError {
  constructor(unit) {
    super(`Invalid unit ${unit}`);
  }
}

/**
 * @private
 */
export class InvalidArgumentError extends LuxonError {}

/**
 * @private
 */
export class ZoneIsAbstractError extends LuxonError {
  constructor() {
    super("Zone is an abstract class");
  }
}

/**
 * Thrown when the runtime has no `Temporal` global. Either run on an engine that ships Temporal,
 * or import a polyfill first (for example `import "momentum/polyfill"`).
 */
export class TemporalUnavailableError extends LuxonError {
  constructor() {
    super(
      "Temporal is not available in this environment. Import a polyfill before using momentum, e.g. `import \"momentum/polyfill\"`."
    );
    this.name = "TemporalUnavailableError";
  }
}
