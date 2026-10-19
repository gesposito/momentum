import { DateTime } from "@momentum-js/luxon";
import { firstMeeting, nextMeeting, slot } from "./dates";

const first = firstMeeting();
const second = nextMeeting(first);

export const summary = {
  firstDay: first.toISODate(),
  secondWeekday: second.weekday,
  ordered: first < second,
  gapHours: (second.toMillis() - first.toMillis()) / 3_600_000,
  endsAt: first.plus({ minutes: 45 }).hour,
  slotMinutes: slot.as("minutes"),
  utcHour: first.toUTC().hour,
  label: `meeting at ${second.toISO()}`,
};

export function isSameInstant(a: DateTime, b: DateTime): boolean {
  return a.toMillis() === b.toMillis();
}
