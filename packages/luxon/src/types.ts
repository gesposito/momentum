import type Zone from "./zone.js";
import type Duration from "./duration.js";
import type DateTime from "./datetime.js";
import type Locale from "./impl/locale.js";

// UNITS

export type DateTimeUnit =
  "year" | "quarter" | "month" | "week" | "day" | "hour" | "minute" | "second" | "millisecond";
export type DateTimeUnitPlural = `${DateTimeUnit}s`;

export type DurationUnit =
  | "years"
  | "quarters"
  | "months"
  | "weeks"
  | "days"
  | "hours"
  | "minutes"
  | "seconds"
  | "milliseconds";
export type DurationUnitSingular =
  "year" | "quarter" | "month" | "week" | "day" | "hour" | "minute" | "second" | "millisecond";
export type DurationUnits = DurationUnit | DurationUnitSingular;

export type ToRelativeUnit =
  "years" | "quarters" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds";
export type ToRelativeCalendarUnit = "years" | "quarters" | "months" | "weeks" | "days";

export type ConversionAccuracy = "casual" | "longterm";
/** `matrix[largerUnit][smallerUnit]` is how many of the smaller unit make one of the larger unit */
export type ConversionMatrix = Partial<Record<DurationUnit, Partial<Record<DurationUnit, number>>>>;

// ZONES

export type ZoneLike = string | number | Zone | null | undefined;
export type ZoneOffsetFormat = "narrow" | "short" | "techie";
export interface ZoneOffsetOptions {
  format?: "short" | "long";
  locale?: string;
}

// LOCALE

export interface WeekSettings {
  firstDay: number;
  minimalDays: number;
  weekend: number[];
}

export interface LocaleOptions {
  locale?: string | null;
  numberingSystem?: string | null;
  outputCalendar?: string | null;
  weekSettings?: WeekSettings | null;
}

export type NumberingSystem = string;
export type CalendarSystem = string;

// DATETIME

export interface DateTimeOptions extends LocaleOptions {
  zone?: ZoneLike;
  setZone?: boolean;
}

export interface DateObjectUnits {
  year?: number;
  month?: number;
  day?: number;
  ordinal?: number;
  weekYear?: number;
  weekNumber?: number;
  weekday?: number;
  localWeekYear?: number;
  localWeekNumber?: number;
  localWeekday?: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export interface GregorianDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export interface GregorianDateTimeWithConfig extends GregorianDateTime {
  outputCalendar?: string | null;
  numberingSystem?: string | null;
  locale?: string;
}

export type ToISOFormat = "basic" | "extended";

export interface ToISODateOptions {
  format?: ToISOFormat;
  precision?: DateTimeUnit | DateTimeUnitPlural;
}

export interface ToISOTimeOptions {
  suppressMilliseconds?: boolean;
  suppressSeconds?: boolean;
  includeOffset?: boolean;
  includePrefix?: boolean;
  extendedZone?: boolean;
  format?: ToISOFormat;
  precision?: DateTimeUnit | DateTimeUnitPlural;
}

export type ToISOOptions = Omit<ToISOTimeOptions, "includePrefix">;

export interface ToSQLOptions {
  includeOffset?: boolean;
  includeZone?: boolean;
  includeOffsetSpace?: boolean;
}

export interface ToObjectOptions {
  includeConfig?: boolean;
}

export interface StartOfOptions {
  useLocaleWeeks?: boolean;
}

export type RoundingMode = "trunc" | "expand" | "round" | "floor" | "ceil";

export interface ToRelativeOptions {
  base?: DateTime;
  locale?: string;
  style?: "long" | "short" | "narrow";
  unit?: ToRelativeUnit | ToRelativeUnit[];
  round?: boolean;
  rounding?: RoundingMode;
  padding?: number;
  numberingSystem?: string;
}

export interface ToRelativeCalendarOptions {
  base?: DateTime;
  locale?: string;
  unit?: ToRelativeCalendarUnit;
  numberingSystem?: string;
}

export interface SetZoneOptions {
  keepLocalTime?: boolean;
  keepCalendarTime?: boolean;
}

export interface DiffOptions {
  conversionAccuracy?: ConversionAccuracy;
  locale?: string;
  numberingSystem?: string;
  matrix?: ConversionMatrix;
}

export type DateTimeFormatOptions = Intl.DateTimeFormatOptions;

export interface FormatToken {
  literal: boolean;
  val: string;
}

export interface ExplainedFormat {
  input: string;
  tokens: FormatToken[];
  regex?: RegExp;
  rawMatches?: RegExpMatchArray | null;
  matches?: Record<string, number | string>;
  result?: DateObjectUnits | null;
  zone?: Zone | null;
  specificOffset?: number;
  invalidReason?: string | null;
}

export type DateTimeLike = DateTime | Date | DateObjectUnits;

// DURATION

export interface DurationLikeObject {
  years?: number;
  year?: number;
  quarters?: number;
  quarter?: number;
  months?: number;
  month?: number;
  weeks?: number;
  week?: number;
  days?: number;
  day?: number;
  hours?: number;
  hour?: number;
  minutes?: number;
  minute?: number;
  seconds?: number;
  second?: number;
  milliseconds?: number;
  millisecond?: number;
}

export type DurationLike = Duration | DurationLikeObject | number;

export type DurationObjectUnits = Partial<Record<DurationUnit, number>>;

export interface DurationOptions {
  locale?: string | null;
  numberingSystem?: string | null;
  conversionAccuracy?: ConversionAccuracy;
  matrix?: ConversionMatrix;
}

export interface DurationToFormatOptions {
  floor?: boolean;
  /** @deprecated use `floor` */
  round?: boolean;
  signMode?: "negative" | "all" | "negativeLargestOnly";
}

export interface ToHumanDurationOptions extends Intl.NumberFormatOptions {
  listStyle?: "long" | "short" | "narrow";
  showZeros?: boolean;
}

export interface DurationToISOTimeOptions {
  suppressMilliseconds?: boolean;
  suppressSeconds?: boolean;
  includePrefix?: boolean;
  format?: ToISOFormat;
}

// INFO

export interface InfoOptions {
  locale?: string | null;
  locObj?: Locale | null;
}

export interface InfoUnitOptions extends InfoOptions {
  numberingSystem?: string | null;
}

export interface InfoCalendarOptions extends InfoUnitOptions {
  outputCalendar?: string;
}

export interface Features {
  relative: boolean;
  localeWeek: boolean;
}

export type UnitLength = "narrow" | "short" | "long" | "numeric" | "2-digit";
export type StringUnitLength = "narrow" | "short" | "long";
