// Standalone Node test runner for csvParser.js and matcher.js -- no browser,
// no auth dependency. Run with: node test/run_tests.js
//
// Verifies the JS port against the same real CSV used to verify the
// original Flask version (Typing-Lesson-Details.csv), plus targeted cases
// for the grading rule and name matching.

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { parseTypingCsv, groupByClassAndLesson } = require("../js/csvParser.js");
const { computeGrade, matchStudent, normalizeName } = require("../js/matcher.js");
const {
  CURRICULUM,
  unitName,
  naturalSort,
  periodSortKey,
  comparePeriodKeys,
  curriculumLessonGroups,
} = require("../js/curriculum.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  - ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

console.log("csvParser.js against real CSV export");

const csvPath = path.join(__dirname, "..", "..", "Typing-Lesson-Details.csv");
const csvText = fs.readFileSync(csvPath, "utf8");
const rows = parseTypingCsv(csvText);
const groups = groupByClassAndLesson(rows);

test("parses all data rows (51 expected, matches Flask version's verified count)", () => {
  assert.strictEqual(rows.length, 51, `got ${rows.length} rows`);
});

test("groups into 35 class+lesson pairs (matches Flask version's verified count)", () => {
  assert.strictEqual(groups.size, 35, `got ${groups.size} groups`);
});

test("handles quoted lesson titles with embedded commas", () => {
  const row = rows.find((r) => r.lastName === "Blair");
  assert.ok(row, "expected to find Sean-Peter Blair row");
  assert.strictEqual(row.lesson, "Learn the Keys 1: 1. J, F, and Space");
});

test("strips % and truncates progress to an integer", () => {
  const row = rows.find((r) => r.lastName === "Blair");
  assert.strictEqual(row.progressPct, 36);
  assert.strictEqual(typeof row.progressPct, "number");
});

test("every parsed row has non-empty first/last/class/lesson", () => {
  for (const r of rows) {
    assert.ok(r.firstName && r.lastName && r.className && r.lesson);
  }
});

console.log("\nmatcher.js grading rule (3-tier: 0% / 80% / 100%)");

test("progress < 100% earns 0, regardless of turn-in status", () => {
  assert.strictEqual(computeGrade(99, 100, true), 0);
  assert.strictEqual(computeGrade(0, 100, false), 0);
  assert.strictEqual(computeGrade(36, 100, true), 0);
});

test("progress == 100% and turned in earns full points", () => {
  assert.strictEqual(computeGrade(100, 100, true), 100);
  assert.strictEqual(computeGrade(100, 50, true), 50);
});

test("progress == 100% but not turned in earns 80% of points", () => {
  assert.strictEqual(computeGrade(100, 100, false), 80);
  assert.strictEqual(computeGrade(100, 50, false), 40);
});

test("turnedIn defaults to true when omitted", () => {
  assert.strictEqual(computeGrade(100, 100), 100);
});

console.log("\nmatcher.js name matching");

const roster = [
  { userId: "1", givenName: "Margarita", familyName: "Cervantes" },
  { userId: "2", givenName: "Emilio", familyName: "Carmona Santos" },
  { userId: "3", givenName: "margarita", familyName: "cervantes" }, // deliberate collision, different case
];

test("matches exactly one roster entry (case/whitespace-insensitive)", () => {
  const { student, status } = matchStudent("Emilio", "Carmona Santos", roster);
  assert.strictEqual(status, "matched");
  assert.strictEqual(student.userId, "2");
});

test("flags ambiguous when more than one roster entry matches", () => {
  const { student, status } = matchStudent("Margarita", "Cervantes", roster);
  assert.strictEqual(status, "ambiguous");
  assert.strictEqual(student, null);
});

test("flags not_found when no roster entry matches", () => {
  const { student, status } = matchStudent("Nobody", "Here", roster);
  assert.strictEqual(status, "not_found");
  assert.strictEqual(student, null);
});

test("normalizeName collapses whitespace and case", () => {
  assert.strictEqual(normalizeName("  Emilio   "), "emilio");
  assert.strictEqual(normalizeName("Carmona  Santos"), "carmona santos");
});

console.log("\ncurriculum.js");

test("unitName extracts the unit from '<Unit>: <N>. <Title>'", () => {
  assert.strictEqual(unitName("Learn the Keys 1: 1. J, F, and Space"), "Learn the Keys 1");
});

test("unitName falls back to the whole string when there's no ': '", () => {
  assert.strictEqual(unitName("Just for Fun"), "Just for Fun");
});

test("naturalSort orders embedded numbers numerically, not lexically", () => {
  const input = [
    "Learn the Keys 1: 10. Beginner Review 2",
    "Learn the Keys 1: 2. U, R, and K Keys",
    "Learn the Keys 1: 1. J, F, and Space",
  ];
  const sorted = naturalSort(input);
  assert.deepStrictEqual(sorted, [
    "Learn the Keys 1: 1. J, F, and Space",
    "Learn the Keys 1: 2. U, R, and K Keys",
    "Learn the Keys 1: 10. Beginner Review 2",
  ]);
});

test("period sort interleaves preps by period number (P1, P2, ... before P10)", () => {
  const classes = ["WAD-P10-S1-2627", "WPD-P1-S1-2627", "WAD-P2-S1-2627", "WPD-P2-S1-2627"];
  const sorted = [...classes].sort((a, b) => comparePeriodKeys(periodSortKey(a), periodSortKey(b)));
  assert.deepStrictEqual(sorted, ["WPD-P1-S1-2627", "WAD-P2-S1-2627", "WPD-P2-S1-2627", "WAD-P10-S1-2627"]);
});

test("classes without a P<number> sort after all that have one", () => {
  const classes = ["WAD-P2-S1-2627", "Homeroom"];
  const sorted = [...classes].sort((a, b) => comparePeriodKeys(periodSortKey(a), periodSortKey(b)));
  assert.deepStrictEqual(sorted, ["WAD-P2-S1-2627", "Homeroom"]);
});

test("curriculumLessonGroups builds full titles in unit + numeric order", () => {
  const groups = curriculumLessonGroups([]);
  const [firstUnit, firstLessons] = groups[0];
  assert.strictEqual(firstUnit, "Learn the Keys 1");
  assert.strictEqual(firstLessons[0], "Learn the Keys 1: 1. J, F, and Space");
  assert.strictEqual(firstLessons[1], "Learn the Keys 1: 2. U, R, and K Keys");
  assert.strictEqual(firstLessons.length, CURRICULUM["Learn the Keys 1"].length);
});

test("curriculumLessonGroups orders units per UNIT_ORDER, not alphabetically", () => {
  const groups = curriculumLessonGroups([]);
  const unitNames = groups.map(([unit]) => unit);
  const keysIdx = unitNames.indexOf("Learn the Keys 1");
  const crossIdx = unitNames.indexOf("Cross Curricular 1");
  assert.ok(keysIdx < crossIdx, "Learn the Keys 1 should come before Cross Curricular 1");
});

test("curriculumLessonGroups adds plan lessons CURRICULUM doesn't cover (safety net)", () => {
  const plan = [{ unit: "Learn the Keys 1", lesson: "Learn the Keys 1: 99. A New Lesson" }];
  const groups = curriculumLessonGroups(plan);
  const [, lessons] = groups.find(([unit]) => unit === "Learn the Keys 1");
  assert.ok(lessons.includes("Learn the Keys 1: 99. A New Lesson"));
});

test("curriculumLessonGroups adds a brand-new unit from the plan too", () => {
  const plan = [{ unit: "Brand New Unit", lesson: "Brand New Unit: 1. Something" }];
  const groups = curriculumLessonGroups(plan);
  const unitNames = groups.map(([unit]) => unit);
  assert.ok(unitNames.includes("Brand New Unit"));
  // Not in UNIT_ORDER, so it should sort after all known units.
  assert.strictEqual(unitNames[unitNames.length - 1], "Brand New Unit");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
