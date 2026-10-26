import { test } from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "../src/errors";
import { formatInteractionScript, parseInteractionScript, parseInteractions } from "../src/interactions";
import { LIMITS } from "../src/limits";

const MAX = 1800;

test("Skript: alle Aktionen, Zeitformate, Kommentare, Aliase", () => {
  const steps = parseInteractionScript(
    [
      "# Beispiel",
      "30 pause 5        # fünf Sekunden",
      "1:00 seek +30",
      "1:30 spulen -15",
      "",
      "2:00 next",
      "2:30 zurück",
    ].join("\n"),
    MAX
  );

  assert.deepEqual(steps, [
    { at: 30, action: "pause", value: 5 },
    { at: 60, action: "seek", value: 30 },
    { at: 90, action: "seek", value: -15 },
    { at: 120, action: "next" },
    { at: 150, action: "previous" },
  ]);
});

test("Skript: Pause ohne Wert nutzt 5 s, Werte dürfen ein 's' tragen", () => {
  assert.deepEqual(parseInteractionScript("10 pause\n20 seek 15s", MAX), [
    { at: 10, action: "pause", value: 5 },
    { at: 20, action: "seek", value: 15 },
  ]);
});

test("Skript: Schritte werden nach Zeit sortiert (stabil)", () => {
  const steps = parseInteractionScript("60 next\n10 seek 5\n30 previous", MAX);

  assert.deepEqual(
    steps.map((s) => s.at),
    [10, 30, 60]
  );
});

test("Skript: Fehler nennen die Zeilennummer und sind verständlich", () => {
  const bad: [string, RegExp][] = [
    ["abc pause 5", /Zeile 1.*Zeit/],
    ["10 tanzen", /Zeile 1.*unbekannt/],
    ["10", /Zeile 1.*erwartet/],
    ["10 seek 1 2 3", /Zeile 1.*erwartet/],
    ["# ok\n\n10 seek", /Zeile 3.*Sprung/],
    ["10 seek 0", /Sprung/],
    [`10 seek ${LIMITS.maxSeekSec + 1}`, /Sprung/],
    ["10 pause 0", /Pause/],
    [`10 pause ${LIMITS.maxPauseSec + 1}`, /Pause/],
    ["10 next 5", /keinen Wert/],
    ["10 seek zehn", /Wert/],
    [`${MAX + 1} next`, /zwischen 0 und/],
    ["1:99 next", /ungültig/],
  ];

  for (const [text, re] of bad) {
    assert.throws(() => parseInteractionScript(text, MAX), (e: unknown) => e instanceof ValidationError && re.test(e.message), text);
  }
});

test("Skript: Schritte dürfen sich nicht überlappen (Mindestabstand, Pausen zählen mit)", () => {
  const gap = LIMITS.minInteractionGapSec;

  assert.doesNotThrow(() => parseInteractionScript(`10 seek 5\n${10 + gap} seek 5`, MAX));
  assert.throws(() => parseInteractionScript(`10 seek 5\n${10 + gap - 1} seek 5`, MAX), /zu früh/);
  // Pause 10 s ab Sekunde 10 belegt die Zeit bis 20
  assert.throws(() => parseInteractionScript("10 pause 10\n15 seek 5", MAX), /zu früh.*frühestens bei 22 s/);
  assert.doesNotThrow(() => parseInteractionScript("10 pause 10\n22 seek 5", MAX));
});

test("Skript: Höchstzahl der Schritte", () => {
  const ok = Array.from({ length: LIMITS.maxInteractionSteps }, (_, i) => `${i * 3} seek 5`).join("\n");
  const tooMany = ok + `\n${LIMITS.maxInteractionSteps * 3} seek 5`;

  assert.equal(parseInteractionScript(ok, 10_000).length, LIMITS.maxInteractionSteps);
  assert.throws(() => parseInteractionScript(tooMany, 10_000), /Höchstens/);
});

test("Skript: Anzeige und Rückweg (Rundlauf)", () => {
  const steps = parseInteractionScript("30 pause 5\n1:05 seek +30\n1:40 seek -15\n2:10 next\n2:20 previous", MAX);
  const text = formatInteractionScript(steps);

  assert.equal(text, "0:30 pause 5\n1:05 seek +30\n1:40 seek -15\n2:10 next\n2:20 previous");
  assert.deepEqual(parseInteractionScript(text, MAX), steps);
});

test("parseInteractions: fehlend/leer, Text, Liste; alles andere wird abgelehnt", () => {
  assert.deepEqual(parseInteractions(undefined, MAX), []);
  assert.deepEqual(parseInteractions(null, MAX), []);
  assert.deepEqual(parseInteractions("", MAX), []);
  assert.deepEqual(parseInteractions("10 next", MAX), [{ at: 10, action: "next" }]);
  assert.deepEqual(parseInteractions([{ at: 10, action: "seek", value: -5 }, { at: 20, action: "pause" }], MAX), [
    { at: 10, action: "seek", value: -5 },
    { at: 20, action: "pause", value: 5 },
  ]);

  const bad: unknown[] = [
    5,
    {},
    true,
    ["x"],
    [null],
    [{ at: 1.5, action: "next" }],
    [{ at: -1, action: "next" }],
    [{ at: "10", action: "next" }],
    [{ at: 10, action: "explode" }],
    [{ at: 10, action: "seek" }],
    [{ at: 10, action: "seek", value: "5" }],
    [{ at: 10, action: "next", value: 1 }],
    [{ at: 10, action: "next", extra: 1 }],
    [{ at: 10, action: "next" }, { at: 10, action: "next" }],
    "x".repeat(10_001),
  ];

  for (const b of bad) {
    assert.throws(() => parseInteractions(b, MAX), ValidationError, JSON.stringify(b)?.slice(0, 60));
  }
});

test("Es gibt keinen Zufall: derselbe Text ergibt immer dieselben Schritte", () => {
  const text = "10 pause 3\n20 seek 15\n30 seek -10\n40 next\n50 previous";
  const a = JSON.stringify(parseInteractionScript(text, MAX));

  for (let i = 0; i < 20; i++) assert.equal(JSON.stringify(parseInteractionScript(text, MAX)), a);
});
