import Duration from "../duration.js";
import type DateTime from "../datetime.js";
import type { DurationOptions, DurationUnit } from "../types.js";

function dayDiff(earlier: DateTime, later: DateTime): number {
  const utcDayStart = (dt: DateTime) =>
      dt.toUTC(0, { keepLocalTime: true }).startOf("day").valueOf(),
    ms = utcDayStart(later) - utcDayStart(earlier);
  return Math.floor(Duration.fromMillis(ms).as("days"));
}

function highOrderDiffs(
  cursor: DateTime,
  later: DateTime,
  units: DurationUnit[]
): [DateTime, Partial<Record<DurationUnit, number>>, DateTime | undefined, DurationUnit | undefined] {
  const differs: [DurationUnit, (a: DateTime, b: DateTime) => number][] = [
    ["years", (a, b) => b.year - a.year],
    ["quarters", (a, b) => b.quarter - a.quarter + (b.year - a.year) * 4],
    ["months", (a, b) => b.month - a.month + (b.year - a.year) * 12],
    [
      "weeks",
      (a, b) => {
        const days = dayDiff(a, b);
        return (days - (days % 7)) / 7;
      },
    ],
    ["days", dayDiff],
  ];

  const results: Partial<Record<DurationUnit, number>> = {};
  const earlier = cursor;
  let lowestOrder: DurationUnit | undefined, highWater: DateTime | undefined;

  /* This loop tries to diff using larger units first.
     If we overshoot, we backtrack and try the next smaller unit.
     "cursor" starts out at the earlier timestamp and moves closer and closer to "later"
     as we use smaller and smaller units.
     highWater keeps track of where we would be if we added one more of the smallest unit,
     this is used later to potentially convert any difference smaller than the smallest higher order unit
     into a fraction of that smallest higher order unit
  */
  for (const [unit, differ] of differs) {
    if (units.indexOf(unit) >= 0) {
      lowestOrder = unit;

      results[unit] = differ(cursor, later);
      highWater = earlier.plus(results);

      if (highWater > later) {
        // we overshot the end point, backtrack cursor by 1
        (results[unit] as number)--;
        cursor = earlier.plus(results);

        // if we are still overshooting now, we need to backtrack again
        // this happens in certain situations when diffing times in different zones,
        // because this calculation ignores time zones
        if (cursor > later) {
          // keep the "overshot by 1" around as highWater
          highWater = cursor;
          // backtrack cursor by 1
          (results[unit] as number)--;
          cursor = earlier.plus(results);
        }
      } else {
        cursor = highWater;
      }
    }
  }

  return [cursor, results, highWater, lowestOrder];
}

export default function (
  earlier: DateTime,
  later: DateTime,
  units: DurationUnit[],
  opts: DurationOptions
): Duration {
  let [cursor, results, highWater, lowestOrder] = highOrderDiffs(earlier, later, units);

  const remainingMillis = later.valueOf() - cursor.valueOf();

  const lowerOrderUnits = units.filter(
    (u) => ["hours", "minutes", "seconds", "milliseconds"].indexOf(u) >= 0
  );

  if (lowerOrderUnits.length === 0) {
    if ((highWater as DateTime) < later) {
      highWater = cursor.plus({ [lowestOrder as DurationUnit]: 1 });
    }

    if (highWater !== cursor) {
      results[lowestOrder as DurationUnit] =
        (results[lowestOrder as DurationUnit] || 0) +
        remainingMillis / ((highWater as DateTime).valueOf() - cursor.valueOf());
    }
  }

  const duration = Duration.fromObject(results, opts);

  if (lowerOrderUnits.length > 0) {
    return Duration.fromMillis(remainingMillis, opts)
      .shiftTo(...lowerOrderUnits)
      .plus(duration);
  } else {
    return duration;
  }
}
