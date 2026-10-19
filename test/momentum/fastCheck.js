// fast-check, configured for the property tests of this repository, and the generators they share.
//
// Every property runs 100 times by default, which keeps the suite fast. FC_NUM_RUNS raises that
// for a longer fuzzing session:
//
//   FC_NUM_RUNS=20000 bun run jest test/momentum
//
// A failing property reports the seed and the path of its shrunk counterexample. FC_SEED and
// FC_PATH replay exactly that case:
//
//   FC_SEED=-1819918769 FC_PATH="12:3" bun run jest -t "name of the test"
import * as fc from "fast-check";

fc.configureGlobal({
  numRuns: Number(process.env.FC_NUM_RUNS) || 100,
  ...(process.env.FC_SEED === undefined
    ? {}
    : {
        seed: Number(process.env.FC_SEED),
        ...(process.env.FC_PATH === undefined ? {} : { path: process.env.FC_PATH }),
        endOnFailure: true,
      }),
});

export { fc };

const T = globalThis.Temporal,
  DAY = 86400000;

/** Any instant Temporal can represent, in whole milliseconds. */
export const anyInstant = fc
  .tuple(fc.integer({ min: -1e8, max: 1e8 - 1 }), fc.integer({ min: 0, max: DAY - 1 }))
  .map(([days, ms]) => days * DAY + ms);

const transitionsByZone = new Map();

/** The instants of a zone's offset transitions between 1800 and 2100. */
export function transitions(zone) {
  let list = transitionsByZone.get(zone);
  if (list === undefined) {
    list = [];
    const end = Date.UTC(2100, 0, 1);
    let next = T.Instant.fromEpochMilliseconds(Date.UTC(1800, 0, 1))
      .toZonedDateTimeISO(zone)
      .getTimeZoneTransition("next");
    while (next !== null && next.epochMilliseconds < end) {
      list.push(next.epochMilliseconds);
      next = next.getTimeZoneTransition("next");
    }
    transitionsByZone.set(zone, list);
  }
  return list;
}

/** An instant within two hours of one of the zone's transitions, or any instant if it has none. */
export function nearTransition(zone) {
  const list = transitions(zone);
  if (list.length === 0) return anyInstant;
  return fc
    .tuple(fc.constantFrom(...list), fc.integer({ min: -2 * 3600000, max: 2 * 3600000 }))
    .map(([transition, delta]) => transition + delta);
}

/**
 * Wall-clock fields within two hours of one of the zone's transitions, as plain fields. They are
 * counted from the wall clock just before the transition, so they also land in the gap of a
 * skipped hour and in both halves of a repeated one.
 */
export function wallClockNearTransition(zone) {
  const list = transitions(zone);
  if (list.length === 0) return anyInstant.map((ts) => fieldsAt(ts, zone));
  return fc
    .tuple(fc.constantFrom(...list), fc.integer({ min: -120, max: 120 }))
    .map(([transition, minutes]) =>
      plainFields(
        T.Instant.fromEpochMilliseconds(transition - 1)
          .toZonedDateTimeISO(zone)
          .toPlainDateTime()
          .add({ minutes })
          .round("minute")
      )
    );
}

/** The wall-clock fields of an instant in a zone. */
export function fieldsAt(ts, zone) {
  return plainFields(T.Instant.fromEpochMilliseconds(ts).toZonedDateTimeISO(zone));
}

function plainFields(p) {
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: p.millisecond,
  };
}
