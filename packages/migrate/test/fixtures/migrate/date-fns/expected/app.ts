/** A free trial ends 14 days after signing up, at the end of that day. */
export function trialEnd(signedUp: Date): Date {
  return new Date(Temporal.Instant.fromEpochMilliseconds(signedUp.getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()).add({ days: 14 }).with({ hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0 }, { offset: "ignore" }).epochMilliseconds);
}

const signedUp = new Date(Temporal.PlainDateTime.from("2026-03-01T10:30:00").toZonedDateTime(Temporal.Now.timeZoneId()).epochMilliseconds);
export const ends = trialEnd(signedUp).toISOString();
export const endsOnWeekday = Temporal.Instant.fromEpochMilliseconds(trialEnd(signedUp).getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()).dayOfWeek % 7;
export const daysInMonth = Temporal.Instant.fromEpochMilliseconds(signedUp.getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()).daysInMonth;
export const hoursLeft = Math.trunc((Temporal.Instant.fromEpochMilliseconds(trialEnd(signedUp).getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()).epochMilliseconds - Temporal.Instant.fromEpochMilliseconds(signedUp.getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()).epochMilliseconds) / 3600000) || 0;
export const later = Temporal.ZonedDateTime.compare(Temporal.Instant.fromEpochMilliseconds(trialEnd(signedUp).getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()), Temporal.Instant.fromEpochMilliseconds(signedUp.getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId())) > 0;
export const stamp = new Date(Temporal.Instant.from("2026-03-15T12:34:56Z").toZonedDateTimeISO(Temporal.Now.timeZoneId()).with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }, { offset: "ignore" }).epochMilliseconds).getTime();
export const label = Temporal.Instant.fromEpochMilliseconds(signedUp.getTime()).toZonedDateTimeISO(Temporal.Now.timeZoneId()).toPlainDate().toString();
