import { test, expect } from "vitest";
import { eventRows, eventTime, eventRow } from "../src/model/events.js";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
const dates = Array.from({ length: 4 }, (_, i) =>
  new Date(Date.now() - (i + 1) * 60000).toISOString(),
);
const fixtures = [
  {
    metadata: { name: "a", namespace: "ns", creationTimestamp: dates[3] },
    series: { lastObservedTime: dates[0], count: 9 },
    count: 2,
    lastTimestamp: dates[1],
  },
  { metadata: { name: "b" }, lastTimestamp: dates[1], eventTime: dates[2] },
  { metadata: { name: "c" }, eventTime: dates[2] },
  { metadata: { name: "d", creationTimestamp: dates[3] } },
];
test("all event times and series count", () => {
  fixtures.forEach((f, i) => expect(eventTime(f)).toBe(dates[i]));
  expect(eventRows([...fixtures].reverse()).map((x) => x.created)).toEqual(
    dates,
  );
  expect(eventRow(fixtures[0] ?? {}).cells.count).toBe(9);
});
test("redact before preview and full", () => {
  const raw = {
    ...fixtures[0],
    type: "Warning",
    reason: "Failed",
    involvedObject: { kind: "Pod", name: "p" },
    message: "password=CANARY " + "x".repeat(200),
  };
  for (const full of [true, false]) {
    const row = eventRow(raw, full);
    expect(row.cells.message).not.toContain("CANARY");
    expect(row.cells.object).toBe("ns/Pod/p");
  }
  expect(eventRow(raw).cells.message).toContain("chars total");
});
test("events scope, filtering and argv", () => {
  const l = lab([
    {
      prefix: ["get", "namespace", "missing"],
      stderr: "Error from server (NotFound)",
      code: 1,
    },
    { prefix: ["get", "events"], stdout: JSON.stringify({ items: fixtures }) },
    ...targetRules(),
  ]);
  try {
    const p = cli(
      ["events", "-A", "--warnings", "--since", "2m", "--for", "Pod/p"],
      l.env,
    );
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("1 of 1 total");
    expect(
      l
        .calls()
        .some((c) =>
          c.args.includes(
            "--field-selector=type=Warning,involvedObject.kind=Pod,involvedObject.name=p",
          ),
        ),
    ).toBe(true);
    expect(cli(["events", "-n", "missing"], l.env).stdout).toContain(
      "NAMESPACE_NOT_FOUND",
    );
  } finally {
    l.clean();
  }
  const empty = lab(targetRules());
  try {
    const p = cli(["events"], empty.env);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("namespace exists");
  } finally {
    empty.clean();
  }
});
