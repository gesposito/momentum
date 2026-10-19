/** A free trial ends 14 days after signing up, at the end of that day. */
export function trialEnd(signedUp: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  return signedUp.add({ days: 14 }).with({ hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0 }, { offset: "ignore" });
}

const signedUp = Temporal.PlainDateTime.from("2026-03-01T10:30:00").toZonedDateTime(Temporal.Now.timeZoneId());
export const ends = trialEnd(signedUp).toInstant().toString({ fractionalSecondDigits: 3 });
export const endsOnWeekday = trialEnd(signedUp).dayOfWeek % 7;
export const daysInMonth = signedUp.daysInMonth;
export const hoursLeft = Math.trunc((trialEnd(signedUp).epochMilliseconds - signedUp.epochMilliseconds) / 3600000);
export const later = Temporal.ZonedDateTime.compare(trialEnd(signedUp), signedUp) > 0;
export const stamp = Temporal.Instant.from("2026-03-15T12:34:56Z").toZonedDateTimeISO("UTC").with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }, { offset: "ignore" }).epochMilliseconds;
export const label = `${(signedUp.month - 1) + 1}/${signedUp.day}/${signedUp.year}`;
