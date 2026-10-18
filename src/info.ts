import DateTime from "./datetime.js";
import Settings from "./settings.js";
import Locale from "./impl/locale.js";
import IANAZone from "./zones/IANAZone.js";
import { normalizeZone } from "./impl/zoneUtil.js";
import type Zone from "./zone.js";

import { hasLocaleWeekInfo, hasRelative } from "./impl/util.js";
import type {
  Features,
  InfoCalendarOptions,
  InfoOptions,
  InfoUnitOptions,
  StringUnitLength,
  UnitLength,
  ZoneLike,
} from "./types.js";

/**
 * The Info class contains static methods for retrieving general time and date related data. For example, it has methods for finding out if a time zone has a DST, for listing the months in any supported locale, and for discovering which of momentum's features are available in the current environment.
 */
export default class Info {
  /**
   * Return whether the specified zone contains a DST.
   * @param zone - Zone to check. Defaults to the environment's local zone.
   */
  static hasDST(zone: Zone | ZoneLike = Settings.defaultZone): boolean {
    const proto = DateTime.now().setZone(zone).set({ month: 12 });

    return !(zone as Zone).isUniversal && proto.offset !== proto.set({ month: 6 }).offset;
  }

  /**
   * Return whether the specified zone is a valid IANA specifier.
   * @param zone - Zone to check
   */
  static isValidIANAZone(zone: string): boolean {
    return IANAZone.isValidZone(zone);
  }

  /**
   * Converts the input into a {@link Zone} instance.
   *
   * * If `input` is already a Zone instance, it is returned unchanged.
   * * If `input` is a string containing a valid time zone name, a Zone instance
   *   with that name is returned.
   * * If `input` is a string that doesn't refer to a known time zone, a Zone
   *   instance with {@link Zone#isValid} == false is returned.
   * * If `input is a number, a Zone instance with the specified fixed offset
   *   in minutes is returned.
   * * If `input` is `null` or `undefined`, the default zone is returned.
   * @param input - the value to be converted
   */
  static normalizeZone(input?: ZoneLike): Zone {
    return normalizeZone(input, Settings.defaultZone);
  }

  /**
   * Get the weekday on which the week starts according to the given locale.
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.locObj - an existing locale object to use
   * @returns the start of the week, 1 for Monday through 7 for Sunday
   */
  static getStartOfWeek({ locale = null, locObj = null }: InfoOptions = {}): number {
    return (locObj || Locale.create(locale)).getStartOfWeek();
  }

  /**
   * Get the minimum number of days necessary in a week before it is considered part of the next year according
   * to the given locale.
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.locObj - an existing locale object to use
   */
  static getMinimumDaysInFirstWeek({ locale = null, locObj = null }: InfoOptions = {}): number {
    return (locObj || Locale.create(locale)).getMinDaysInFirstWeek();
  }

  /**
   * Get the weekdays, which are considered the weekend according to the given locale
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.locObj - an existing locale object to use
   * @returns an array of weekdays, 1 for Monday through 7 for Sunday
   */
  static getWeekendWeekdays({ locale = null, locObj = null }: InfoOptions = {}): number[] {
    // copy the array, because we cache it internally
    return (locObj || Locale.create(locale)).getWeekendDays().slice();
  }

  /**
   * Return an array of standalone month names.
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
   * @param length - the length of the month representation, such as "numeric", "2-digit", "narrow", "short", "long"
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.numberingSystem - the numbering system
   * @param opts.locObj - an existing locale object to use
   * @param opts.outputCalendar - the calendar
   * @example Info.months()[0] //=> 'January'
   * @example Info.months('short')[0] //=> 'Jan'
   * @example Info.months('numeric')[0] //=> '1'
   * @example Info.months('short', { locale: 'fr-CA' } )[0] //=> 'janv.'
   * @example Info.months('numeric', { locale: 'ar' })[0] //=> '١'
   * @example Info.months('long', { outputCalendar: 'islamic' })[0] //=> 'Rabiʻ I'
   */
  static months(
    length: UnitLength = "long",
    {
      locale = null,
      numberingSystem = null,
      locObj = null,
      outputCalendar = "gregory",
    }: InfoCalendarOptions = {}
  ): string[] {
    return (locObj || Locale.create(locale, numberingSystem, outputCalendar)).months(
      length
    ) as string[];
  }

  /**
   * Return an array of format month names.
   * Format months differ from standalone months in that they're meant to appear next to the day of the month. In some languages, that
   * changes the string.
   * See {@link Info#months}
   * @param length - the length of the month representation, such as "numeric", "2-digit", "narrow", "short", "long"
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.numberingSystem - the numbering system
   * @param opts.locObj - an existing locale object to use
   * @param opts.outputCalendar - the calendar
   */
  static monthsFormat(
    length: UnitLength = "long",
    {
      locale = null,
      numberingSystem = null,
      locObj = null,
      outputCalendar = "gregory",
    }: InfoCalendarOptions = {}
  ): string[] {
    return (locObj || Locale.create(locale, numberingSystem, outputCalendar)).months(
      length,
      true
    ) as string[];
  }

  /**
   * Return an array of standalone week names.
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DateTimeFormat
   * @param length - the length of the weekday representation, such as "narrow", "short", "long".
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.numberingSystem - the numbering system
   * @param opts.locObj - an existing locale object to use
   * @example Info.weekdays()[0] //=> 'Monday'
   * @example Info.weekdays('short')[0] //=> 'Mon'
   * @example Info.weekdays('short', { locale: 'fr-CA' })[0] //=> 'lun.'
   * @example Info.weekdays('short', { locale: 'ar' })[0] //=> 'الاثنين'
   */
  static weekdays(
    length: StringUnitLength = "long",
    { locale = null, numberingSystem = null, locObj = null }: InfoUnitOptions = {}
  ): string[] {
    return (locObj || Locale.create(locale, numberingSystem, null)).weekdays(length) as string[];
  }

  /**
   * Return an array of format week names.
   * Format weekdays differ from standalone weekdays in that they're meant to appear next to more date information. In some languages, that
   * changes the string.
   * See {@link Info#weekdays}
   * @param length - the length of the month representation, such as "narrow", "short", "long".
   * @param opts - options
   * @param opts.locale - the locale code
   * @param opts.numberingSystem - the numbering system
   * @param opts.locObj - an existing locale object to use
   */
  static weekdaysFormat(
    length: StringUnitLength = "long",
    { locale = null, numberingSystem = null, locObj = null }: InfoUnitOptions = {}
  ): string[] {
    return (locObj || Locale.create(locale, numberingSystem, null)).weekdays(
      length,
      true
    ) as string[];
  }

  /**
   * Return an array of meridiems.
   * @param opts - options
   * @param opts.locale - the locale code
   * @example Info.meridiems() //=> [ 'AM', 'PM' ]
   * @example Info.meridiems({ locale: 'my' }) //=> [ 'နံနက်', 'ညနေ' ]
   */
  static meridiems({ locale = null }: { locale?: string | null } = {}): string[] {
    return Locale.create(locale).meridiems() as string[];
  }

  /**
   * Return an array of eras, such as ['BC', 'AD']. The locale can be specified, but the calendar system is always Gregorian.
   * @param length - the length of the era representation, such as "short" or "long".
   * @param opts - options
   * @param opts.locale - the locale code
   * @example Info.eras() //=> [ 'BC', 'AD' ]
   * @example Info.eras('long') //=> [ 'Before Christ', 'Anno Domini' ]
   * @example Info.eras('long', { locale: 'fr' }) //=> [ 'avant Jésus-Christ', 'après Jésus-Christ' ]
   */
  static eras(
    length: StringUnitLength = "short",
    { locale = null }: { locale?: string | null } = {}
  ): string[] {
    return Locale.create(locale, null, "gregory").eras(length) as string[];
  }

  /**
   * Return the set of available features in this environment.
   * Some features of momentum are not available in all environments. For example, on older browsers, relative time formatting support is not available. Use this function to figure out if that's the case.
   * Keys:
   * * `relative`: whether this environment supports relative time formatting
   * * `localeWeek`: whether this environment supports different weekdays for the start of the week based on the locale
   * @example Info.features() //=> { relative: false, localeWeek: true }
   */
  static features(): Features {
    return { relative: hasRelative(), localeWeek: hasLocaleWeekInfo() };
  }
}
