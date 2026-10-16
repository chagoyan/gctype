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
const {
  computeGrade,
  isDueDateReached,
  matchStudent,
  normalizeName,
  findStudentsListedElsewhere,
  rowsListedElsewhere,
} = require("../js/matcher.js");
const {
  CURRICULUM,
  unitName,
  naturalSort,
  periodSortKey,
  comparePeriodKeys,
  canonicalizeLesson,
  curriculumLessonGroups,
} = require("../js/curriculum.js");
const { buildAssignmentDescription } = require("../js/assignmentTemplate.js");
const { buildReminderEmail, reminderCandidates } = require("../js/reminderTemplate.js");
const {
  QUALIFYING_TEST_TYPE,
  parseUsDate,
  parseTestActivityCsv,
  hasQualifyingTest,
} = require("../js/testCsvParser.js");
const { buildTestAssignmentTitle, buildTestAssignmentDescription } = require("../js/testTemplate.js");

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

console.log("\nmatcher.js due date gating");

test("no due date at all counts as always reached", () => {
  assert.strictEqual(isDueDateReached(null), true);
  assert.strictEqual(isDueDateReached(undefined), true);
});

test("due date not reached before 11:59 PM on the due day", () => {
  const dueDate = { year: 2026, month: 8, day: 25 };
  const beforeCutoff = new Date(2026, 7, 25, 15, 0);
  assert.strictEqual(isDueDateReached(dueDate, beforeCutoff), false);
});

test("due date reached just after 11:59 PM on the due day", () => {
  const dueDate = { year: 2026, month: 8, day: 25 };
  const afterCutoff = new Date(2026, 7, 26, 0, 0, 1);
  assert.strictEqual(isDueDateReached(dueDate, afterCutoff), true);
});

test("due date not reached on days before it", () => {
  const dueDate = { year: 2026, month: 8, day: 25 };
  const dayBefore = new Date(2026, 7, 24, 23, 59, 59);
  assert.strictEqual(isDueDateReached(dueDate, dayBefore), false);
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

console.log("\nmatcher.js students Typing.com lists under another class");

// Typing.com lists each student under one class only: a student who
// switched periods keeps the old class name, and a student in two periods
// only shows up under one. Lesson-shaped rows; only names + className matter.
const P1 = "WAD-P1-S1-2627";
const P3 = "WAD-P3-S1-2627";
const P5 = "WAD-P5-S1-2627";
const elsewhereRows = [
  { firstName: "Ada", lastName: "Lovelace", className: P1, lesson: "L1", progressPct: 100 },
  { firstName: "Ada", lastName: "Lovelace", className: P1, lesson: "L2", progressPct: 40 },
  { firstName: "Alan", lastName: "Turing", className: P3, lesson: "L1", progressPct: 100 },
  { firstName: "Grace", lastName: "Hopper", className: P5, lesson: "L1", progressPct: 100 },
];

/** Run both steps the way app.js's fetchRowsListedElsewhere does. */
function borrow(rows, selectedClassName, selectedRoster, otherRosters) {
  const candidates = findStudentsListedElsewhere(rows, selectedClassName, selectedRoster);
  return rowsListedElsewhere(rows, selectedClassName, candidates, new Map(Object.entries(otherRosters)));
}

test("switched periods: borrows the old class's rows when the old roster no longer has them", () => {
  const p3Roster = [
    { userId: "u-ada", givenName: "Ada", familyName: "Lovelace" },
    { userId: "u-alan", givenName: "Alan", familyName: "Turing" },
  ];
  const borrowed = borrow(elsewhereRows, P3, p3Roster, { [P1]: [] });
  assert.strictEqual(borrowed.length, 2);
  for (const r of borrowed) {
    assert.strictEqual(r.className, P3, "re-labelled so it groups with the selected class");
    assert.strictEqual(r.listedUnder, P1);
    assert.strictEqual(r.listedUnderAmbiguous, false);
  }
  assert.deepStrictEqual(borrowed.map((r) => r.lesson), ["L1", "L2"]);
});

test("two periods: borrows when the other roster has the same Classroom account", () => {
  const p3Roster = [{ userId: "u-ada", givenName: "Ada", familyName: "Lovelace" }];
  const p1Roster = [{ userId: "u-ada", givenName: "Ada", familyName: "Lovelace" }];
  const borrowed = borrow(elsewhereRows, P3, p3Roster, { [P1]: p1Roster });
  assert.strictEqual(borrowed.length, 2);
  assert.ok(borrowed.every((r) => r.listedUnder === P1));
});

test("same name, different student: never borrows the other student's rows", () => {
  const p3Roster = [{ userId: "u-ada-p3", givenName: "Ada", familyName: "Lovelace" }];
  const p1Roster = [{ userId: "u-ada-p1", givenName: "Ada", familyName: "Lovelace" }];
  assert.strictEqual(borrow(elsewhereRows, P3, p3Roster, { [P1]: p1Roster }).length, 0);
});

test("a student with rows under the selected class isn't looked up elsewhere", () => {
  const p3Roster = [{ userId: "u-alan", givenName: "Alan", familyName: "Turing" }];
  const candidates = findStudentsListedElsewhere(elsewhereRows, P3, p3Roster);
  assert.strictEqual(candidates.length, 0);
});

test("a roster student with no rows anywhere isn't a candidate", () => {
  const p3Roster = [{ userId: "u-kat", givenName: "Katherine", familyName: "Johnson" }];
  assert.strictEqual(findStudentsListedElsewhere(elsewhereRows, P3, p3Roster).length, 0);
});

test("borrows when the other class has no active Classroom course (null roster)", () => {
  const p3Roster = [{ userId: "u-ada", givenName: "Ada", familyName: "Lovelace" }];
  assert.strictEqual(borrow(elsewhereRows, P3, p3Roster, { [P1]: null }).length, 2);
});

test("name matching across classes ignores case and extra spaces", () => {
  const p3Roster = [{ userId: "u-ada", givenName: " ada ", familyName: "LOVELACE" }];
  assert.strictEqual(borrow(elsewhereRows, P3, p3Roster, { [P1]: [] }).length, 2);
});

test("listed under two trusted classes: includes both but marks them ambiguous", () => {
  const rows = elsewhereRows.concat([
    { firstName: "Ada", lastName: "Lovelace", className: P5, lesson: "L1", progressPct: 100 },
  ]);
  const p3Roster = [{ userId: "u-ada", givenName: "Ada", familyName: "Lovelace" }];
  const borrowed = borrow(rows, P3, p3Roster, { [P1]: [], [P5]: [] });
  assert.strictEqual(borrowed.length, 3);
  assert.ok(borrowed.every((r) => r.listedUnderAmbiguous === true));
  assert.deepStrictEqual([...new Set(borrowed.map((r) => r.listedUnder))].sort(), [P1, P5]);
});

test("only the trusted class counts when the other has a different same-named student", () => {
  const rows = elsewhereRows.concat([
    { firstName: "Ada", lastName: "Lovelace", className: P5, lesson: "L1", progressPct: 100 },
  ]);
  const p3Roster = [{ userId: "u-ada", givenName: "Ada", familyName: "Lovelace" }];
  const p5Roster = [{ userId: "u-other-ada", givenName: "Ada", familyName: "Lovelace" }];
  const borrowed = borrow(rows, P3, p3Roster, { [P1]: [], [P5]: p5Roster });
  assert.strictEqual(borrowed.length, 2);
  assert.ok(borrowed.every((r) => r.listedUnder === P1 && r.listedUnderAmbiguous === false));
});

test("doesn't modify the original CSV rows", () => {
  const p3Roster = [{ userId: "u-ada", givenName: "Ada", familyName: "Lovelace" }];
  borrow(elsewhereRows, P3, p3Roster, { [P1]: [] });
  assert.strictEqual(elsewhereRows[0].className, P1);
  assert.strictEqual(elsewhereRows[0].listedUnder, undefined);
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

test("canonicalizeLesson rewrites a known title's number to CURRICULUM's", () => {
  // Real-world case: "T, S, and L Keys" is canonically #6, but a stale
  // pre-curriculum-trim export logs it under an old, higher number.
  assert.strictEqual(
    canonicalizeLesson("Learn the Keys 1: 7. T, S, and L Keys"),
    "Learn the Keys 1: 6. T, S, and L Keys"
  );
});

test("canonicalizeLesson leaves an already-canonical lesson unchanged", () => {
  assert.strictEqual(
    canonicalizeLesson("Learn the Keys 1: 6. T, S, and L Keys"),
    "Learn the Keys 1: 6. T, S, and L Keys"
  );
});

test("canonicalizeLesson leaves an unrecognized unit unchanged", () => {
  assert.strictEqual(
    canonicalizeLesson("Not A Real Unit: 1. Something"),
    "Not A Real Unit: 1. Something"
  );
});

test("canonicalizeLesson leaves an unrecognized title within a known unit unchanged", () => {
  assert.strictEqual(
    canonicalizeLesson("Learn the Keys 1: 99. A New Lesson"),
    "Learn the Keys 1: 99. A New Lesson"
  );
});

test("canonicalizeLesson leaves a lesson with no ': ' separator unchanged", () => {
  assert.strictEqual(canonicalizeLesson("Just for Fun"), "Just for Fun");
});

console.log("\nassignmentTemplate.js");

test("buildAssignmentDescription fills in every {lesson} placeholder, not just the first", () => {
  const desc = buildAssignmentDescription("Learn the Keys 1: 1. J, F, and Space");
  const occurrences = desc.split("Learn the Keys 1: 1. J, F, and Space").length - 1;
  assert.strictEqual(occurrences, 2, `expected 2 occurrences, got ${occurrences}`);
  assert.ok(!desc.includes("{lesson}"), "no unfilled {lesson} placeholder should remain");
});

console.log("\nreminderTemplate.js");

test("buildReminderEmail fills {firstName} (both occurrences) and lists every lesson", () => {
  const candidate = {
    email: "a@example.com",
    firstName: "Alex",
    lastName: "Ríos",
    lessons: ["WAD-P2-S1-2627 — Learn the Keys 1: 1. J, F, and Space", "WAD-P2-S1-2627 — Learn the Keys 1: 2. U, R, and K Keys"],
  };
  const { subject, body } = buildReminderEmail(
    candidate,
    "Reminder for {firstName}",
    "Hi {firstName}, you finished:\n{lessons}\nThanks, {firstName}"
  );
  assert.strictEqual(subject, "Reminder for Alex");
  assert.ok(body.includes("Hi Alex, you finished:"));
  assert.ok(body.includes("- WAD-P2-S1-2627 — Learn the Keys 1: 1. J, F, and Space"));
  assert.ok(body.includes("- WAD-P2-S1-2627 — Learn the Keys 1: 2. U, R, and K Keys"));
  assert.ok(body.endsWith("Thanks, Alex"), "second {firstName} occurrence should also be filled");
});

test("buildReminderEmail defaults to the built-in templates when none given", () => {
  const { subject, body } = buildReminderEmail({ email: "a@x.com", firstName: "Jo", lastName: "Lee", lessons: ["L1"] });
  assert.ok(subject.length > 0);
  assert.ok(body.includes("Jo"));
});

console.log("\nreminderTemplate.js: reminderCandidates()");

function studentRow(overrides) {
  return {
    firstName: "First",
    lastName: "Last",
    progressPct: 100,
    status: "matched",
    turnedIn: false,
    email: "student@example.com",
    ...overrides,
  };
}

test("includes a matched, 100%-progress, not-turned-in student with an email", () => {
  const plan = [{ className: "WAD-P2", lesson: "Lesson A", students: [studentRow({})] }];
  const candidates = reminderCandidates(plan);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].email, "student@example.com");
  assert.deepStrictEqual(candidates[0].lessons, ["WAD-P2 — Lesson A"]);
});

test("also includes not_yet_due (pre-due-date) students, same as matched", () => {
  const plan = [{ className: "WAD-P2", lesson: "Lesson A", students: [studentRow({ status: "not_yet_due" })] }];
  assert.strictEqual(reminderCandidates(plan).length, 1);
});

test("excludes a student who has turned in", () => {
  const plan = [{ className: "WAD-P2", lesson: "Lesson A", students: [studentRow({ turnedIn: true })] }];
  assert.strictEqual(reminderCandidates(plan).length, 0);
});

test("excludes a student under 100% progress", () => {
  const plan = [{ className: "WAD-P2", lesson: "Lesson A", students: [studentRow({ progressPct: 99 })] }];
  assert.strictEqual(reminderCandidates(plan).length, 0);
});

test("excludes a student with no email on file", () => {
  const plan = [{ className: "WAD-P2", lesson: "Lesson A", students: [studentRow({ email: null })] }];
  assert.strictEqual(reminderCandidates(plan).length, 0);
});

test("excludes non-matched statuses (ambiguous, not_found, no_submission, already_graded)", () => {
  for (const status of ["ambiguous", "not_found", "no_submission", "already_graded"]) {
    const plan = [{ className: "WAD-P2", lesson: "Lesson A", students: [studentRow({ status })] }];
    assert.strictEqual(reminderCandidates(plan).length, 0, `status ${status} should be excluded`);
  }
});

test("dedupes one student across two lesson groups into a single candidate with both lessons", () => {
  const plan = [
    { className: "WAD-P2", lesson: "Lesson A", students: [studentRow({})] },
    { className: "WAD-P2", lesson: "Lesson B", students: [studentRow({})] },
  ];
  const candidates = reminderCandidates(plan);
  assert.strictEqual(candidates.length, 1);
  assert.deepStrictEqual(candidates[0].lessons, ["WAD-P2 — Lesson A", "WAD-P2 — Lesson B"]);
});

console.log("\ntestCsvParser.js against real CSV export");

const testCsvPath = path.join(__dirname, "..", "..", "Test-Activity-Details.csv");
const testCsvText = fs.readFileSync(testCsvPath, "utf8");
const testRows = parseTestActivityCsv(testCsvText);

test("parses all data rows (520 expected)", () => {
  assert.strictEqual(testRows.length, 520, `got ${testRows.length} rows`);
});

test("every parsed row has non-empty first/last/class/test and a real Date", () => {
  for (const r of testRows) {
    assert.ok(r.firstName && r.lastName && r.className && r.test);
    assert.ok(r.date instanceof Date && !Number.isNaN(r.date.getTime()));
  }
});

test("counts match a hand-tally of the export (356 three-minute rows, 6 classes)", () => {
  const threeMin = testRows.filter((r) => r.test === QUALIFYING_TEST_TYPE);
  assert.strictEqual(threeMin.length, 356, `got ${threeMin.length} qualifying-type rows`);
  const classes = new Set(testRows.map((r) => r.className));
  assert.strictEqual(classes.size, 6, `got ${classes.size} classes`);
});

test("Josiah Cannon's 3-minute attempts land on the expected dates", () => {
  const rows = testRows.filter(
    (r) => r.firstName === "Josiah" && r.lastName === "Cannon" && r.test === QUALIFYING_TEST_TYPE
  );
  const isoDates = rows.map((d) => d.date.toISOString().slice(0, 10)).sort();
  assert.deepStrictEqual(isoDates, ["2026-08-18", "2026-08-18", "2026-08-20", "2026-08-24"]);
});

console.log("\ntestCsvParser.js: parseUsDate()");

test("parses a valid MM/DD/YYYY date as local midnight", () => {
  const d = parseUsDate("08/20/2026");
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7); // 0-indexed
  assert.strictEqual(d.getDate(), 20);
  assert.strictEqual(d.getHours(), 0);
});

test("also parses M/D/YY (2-digit year) -- what Excel/Sheets reformats the Date column to after a hand-edit", () => {
  const d = parseUsDate("8/20/26");
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 7);
  assert.strictEqual(d.getDate(), 20);
});

test("rejects a nonsense date instead of silently rolling over", () => {
  assert.strictEqual(parseUsDate("13/40/2026"), null);
});

test("rejects a malformed / empty string", () => {
  assert.strictEqual(parseUsDate("not a date"), null);
  assert.strictEqual(parseUsDate(""), null);
});

console.log("\ntestCsvParser.js: hasQualifyingTest()");

const cannonRows = testRows.filter(
  (r) => r.firstName === "Josiah" && r.lastName === "Cannon" && r.test === QUALIFYING_TEST_TYPE
);

test("finds a qualifying attempt when the window covers it", () => {
  assert.strictEqual(
    hasQualifyingTest(cannonRows, QUALIFYING_TEST_TYPE, parseUsDate("08/18/2026"), parseUsDate("08/18/2026")),
    true
  );
});

test("both window boundary days are inclusive", () => {
  assert.strictEqual(
    hasQualifyingTest(cannonRows, QUALIFYING_TEST_TYPE, parseUsDate("08/19/2026"), parseUsDate("08/25/2026")),
    true // 08/20 and 08/24 both fall inside
  );
});

test("finds nothing when the window misses every attempt", () => {
  assert.strictEqual(
    hasQualifyingTest(cannonRows, QUALIFYING_TEST_TYPE, parseUsDate("08/21/2026"), parseUsDate("08/23/2026")),
    false
  );
});

test("finds nothing when the test-type filter doesn't match, even inside the window", () => {
  assert.strictEqual(
    hasQualifyingTest(cannonRows, "1 Minute Typing Test", parseUsDate("08/01/2026"), parseUsDate("08/31/2026")),
    false
  );
});

console.log("\ntestTemplate.js");

test("buildTestAssignmentTitle builds the exact fixed-prefix title", () => {
  assert.strictEqual(buildTestAssignmentTitle(1), "Typing Test Results 1");
  assert.strictEqual(buildTestAssignmentTitle("2"), "Typing Test Results 2");
});

test("buildTestAssignmentTitle trims stray whitespace so it doesn't break exact-title matching later", () => {
  assert.strictEqual(buildTestAssignmentTitle("  3  "), "Typing Test Results 3");
});

test("buildTestAssignmentDescription fills in the title with no placeholder left behind", () => {
  const desc = buildTestAssignmentDescription(4);
  assert.ok(desc.startsWith("Typing Test Results 4"));
  assert.ok(!desc.includes("{title}"), "no unfilled {title} placeholder should remain");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
