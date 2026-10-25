// These aren't really private, but nor are they really useful to document.

/**
 * Base class of every error thrown by momentum.
 */
export class MomentumError extends Error {}

/**
 * @private
 */
export class InvalidDateTimeError extends MomentumError {
  constructor(reason: { toMessage(): string }) {
    super(`Invalid DateTime: ${reason.toMessage()}`);
  }
}

/**
 * @private
 */
export class InvalidIntervalError extends MomentumError {
  constructor(reason: { toMessage(): string }) {
    super(`Invalid Interval: ${reason.toMessage()}`);
  }
}

/**
 * @private
 */
export class InvalidDurationError extends MomentumError {
  constructor(reason: { toMessage(): string }) {
    super(`Invalid Duration: ${reason.toMessage()}`);
  }
}

/**
 * @private
 */
export class ConflictingSpecificationError extends MomentumError {}

/**
 * @private
 */
export class InvalidUnitError extends MomentumError {
  constructor(unit: string) {
    super(`Invalid unit ${unit}`);
  }
}

/**
 * @private
 */
export class InvalidArgumentError extends MomentumError {}

/**
 * @private
 */
export class ZoneIsAbstractError extends MomentumError {
  constructor() {
    super("Zone is an abstract class");
  }
}

/**
 * Thrown when the runtime has no `Temporal` global. Either run on an engine that ships Temporal,
 * or import a polyfill first (for example `import "@momentum-js/luxon/polyfill"`).
 */
export class TemporalUnavailableError extends MomentumError {
  constructor() {
    super(
      'Temporal is not available in this environment. Import a polyfill before using momentum, e.g. `import "@momentum-js/luxon/polyfill"`.'
    );
    this.name = "TemporalUnavailableError";
  }
}
