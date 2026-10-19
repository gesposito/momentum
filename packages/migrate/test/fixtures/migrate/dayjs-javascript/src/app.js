import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";

dayjs.extend(duration);

// no tsconfig.json: types are inferred from Day.js's declarations
export const nextWeek = dayjs("2026-10-19T09:00").add(1, "week").valueOf();
export const morning = dayjs("2026-10-19T09:30").startOf("hour").toISOString();
// Day.js's own Duration, which is not momentum's
export const span = dayjs.duration(90, "minutes").asHours();
