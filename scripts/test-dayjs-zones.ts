// Runs the Day.js exactness properties (the "agree with Day.js" tests of
// test/momentum/migrateDayjs.test.js) with the system zone set to zones whose rules New York's
// cannot reach: DST changes at midnight, 30-minute and negative DST, quarter-hour offsets, the
// southern hemisphere and UTC. Day.js's local values follow the system zone, so each zone is a
// Jest run of its own.
//
//   bun run test:dayjs-zones                   every zone below
//   bun run test:dayjs-zones Asia/Kathmandu    the zones given
//   FC_NUM_RUNS=1000 bun run test:dayjs-zones  longer properties

const root = new URL("..", import.meta.url).pathname;

const zones =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [
        "America/Havana", // DST changes at midnight
        "America/Santiago", // DST changes at midnight
        "Asia/Beirut", // DST changes at midnight
        "America/Sao_Paulo", // DST changes at midnight, until 2019
        "Australia/Lord_Howe", // 30-minute DST
        "Europe/Dublin", // negative DST in winter
        "Asia/Kathmandu", // +05:45, no DST
        "Pacific/Chatham", // +12:45, with DST
        "Australia/Sydney", // southern hemisphere
        "UTC",
      ];

let failed = false;
for (const zone of zones) {
  const result = Bun.spawnSync(
    ["node_modules/.bin/jest", "test/momentum/migrateDayjs.test.js", "-t", "agree with Day.js"],
    {
      cwd: root,
      env: { ...process.env, TZ: zone, LANG: "en_US.utf8" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = `${result.stdout}${result.stderr}`;
  console.log(`${zone.padEnd(20)} ${/^Tests:.*$/m.exec(output)?.[0] ?? "no test summary"}`);
  if (result.exitCode !== 0) {
    failed = true;
    for (const line of output.split("\n"))
      if (/●|Counterexample|seed:/.test(line)) console.log(`  ${line.trim()}`);
  }
}
process.exit(failed ? 1 : 0);
