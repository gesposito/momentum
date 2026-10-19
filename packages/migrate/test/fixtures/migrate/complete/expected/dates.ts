export const MEETING_ZONE = "America/New_York";

/** The first meeting, at 9:00 in New York. */
export function firstMeeting(): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from({ year: 2017, month: 5, day: 15, hour: 9, minute: 0, second: 0, millisecond: 0, timeZone: MEETING_ZONE });
}

export function nextMeeting(previous: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  return previous.add({ weeks: 1 });
}

export const slot = Temporal.Duration.from({ minutes: 45 });
