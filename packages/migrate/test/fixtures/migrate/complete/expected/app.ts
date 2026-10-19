import { firstMeeting, nextMeeting, slot } from "./dates";

const first = firstMeeting();
const second = nextMeeting(first);

export const summary = {
  firstDay: first.toPlainDate().toString(),
  secondWeekday: second.dayOfWeek,
  ordered: Temporal.ZonedDateTime.compare(first, second) < 0,
  gapHours: (second.epochMilliseconds - first.epochMilliseconds) / 3_600_000,
  endsAt: first.add({ minutes: 45 }).hour,
  slotMinutes: slot.total("minute"),
  utcHour: first.withTimeZone("UTC").hour,
  label: `meeting at ${second.toString({ fractionalSecondDigits: 3, timeZoneName: "never" })}`,
};

export function isSameInstant(a: Temporal.ZonedDateTime, b: Temporal.ZonedDateTime): boolean {
  return a.epochMilliseconds === b.epochMilliseconds;
}
