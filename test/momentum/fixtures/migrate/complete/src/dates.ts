import { DateTime, Duration } from "momentum";

export const MEETING_ZONE = "America/New_York";

/** The first meeting, at 9:00 in New York. */
export function firstMeeting(): DateTime {
  return DateTime.fromObject({ year: 2017, month: 5, day: 15, hour: 9 }, { zone: MEETING_ZONE });
}

export function nextMeeting(previous: DateTime): DateTime {
  return previous.plus({ weeks: 1 });
}

export const slot = Duration.fromObject({ minutes: 45 });
