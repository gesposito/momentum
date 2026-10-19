import { DateTime } from "@momentum-js/luxon";

// no tsconfig.json: types are inferred from momentum's declarations
const launch = DateTime.fromISO("2017-05-15T09:24:15.123+02:00");

export const day = launch.setZone("Asia/Tokyo").toISODate();
export const label = launch.toFormat("DDD");
