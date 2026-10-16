// Parser for Typing.com's "Test Activity Details" export -- a flat log of
// every typing-*test* attempt (Learn-the-Keys-style lessons use a separate
// "Lesson Details" export, see csvParser.js). One row per attempt; a
// student can have many rows on many dates, including several in one
// sitting (retakes).
//
// Expected columns: Username, First Name, Last Name, Class, Curriculum,
// Test, Time Spent, Date, Avg Speed, Avg Acc, Errors / Typed, Grade
//
// Only First Name, Last Name, Class, Test, and Date are used -- Avg
// Speed/Acc/Errors/Typing.com's own Grade are intentionally ignored, same
// "completion, not performance" philosophy as the lesson grader (see
// project memory "project_typing_grading_rule"). Grading here is
// participation: did the student have a qualifying attempt inside a
// teacher-chosen date window (see hasQualifyingTest below and buildTestPlan
// in app.js).

// The only test length this app grades. Chosen deliberately (2026-08-31,
// Manuel) -- other lengths (1 Minute, 5 Minute, 1 Page) logged in the same
// export are ignored even if they fall inside the window.
const QUALIFYING_TEST_TYPE = "3 Minute Typing Test";

// Deliberately duplicated from csvParser.js rather than required/imported:
// this app has no module bundler, each .js file is loaded as a plain
// <script> and expected to be self-contained (see how matcher.js,
// curriculum.js etc. never call into each other). Keeping these two
// six-line helpers in both files is cheaper than introducing a shared
// "utils" file just for them.

/** Minimal RFC4180-ish CSV line splitter -- see csvParser.js's copy for full docs. */
function parseTestCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Split raw CSV text into non-empty lines, stripping a UTF-8 BOM if present. */
function splitTestCsvLines(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
}

/**
 * Parse a Typing.com "Test Activity Details" export's date string as a
 * local-midnight Date. Accepts both "MM/DD/YYYY" (Typing.com's own export
 * format) and "M/D/YY" -- a teacher opening the CSV in Excel/Sheets to
 * hand-edit a row (e.g. fixing a class or student name) and re-saving is
 * enough to make it reformat the Date column to a 2-digit year on its own,
 * with no warning. A 2-digit year is treated as 2000+YY (so "26" ->
 * 2026), which fits how these CSVs are actually used -- always the
 * current school years, never last century. Returns null if malformed,
 * including nonsense like 13/40/2026, which JS's Date constructor would
 * otherwise silently roll over into a different date rather than reject.
 */
function parseUsDate(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec((str || "").trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Parse Test Activity Details CSV export text into row objects.
 *
 * Each row: { firstName, lastName, className, test, date (Date) }. Rows
 * missing a name, class, test type, or a parseable date are skipped.
 *
 * @param {string} fileText - raw CSV file contents
 */
function parseTestActivityCsv(fileText) {
  const lines = splitTestCsvLines(fileText);
  if (lines.length === 0) return [];

  const header = parseTestCsvLine(lines[0]).map((h) => h.trim());
  const colIndex = {};
  header.forEach((name, i) => {
    colIndex[name] = i;
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseTestCsvLine(lines[i]);

    const get = (col) => {
      const idx = colIndex[col];
      return idx === undefined ? "" : (fields[idx] || "").trim();
    };

    const first = get("First Name");
    const last = get("Last Name");
    const className = get("Class");
    const test = get("Test");
    const date = parseUsDate(get("Date"));

    if (!(first && last && className && test && date)) continue;

    rows.push({ firstName: first, lastName: last, className, test, date });
  }
  return rows;
}

/**
 * True if `rows` (typically one student's rows, already filtered by the
 * caller -- see buildTestPlan in app.js) contains at least one attempt of
 * `testType` dated on or between `startDate` and `endDate` (both local-
 * midnight Dates; both boundary days are inclusive).
 */
function hasQualifyingTest(rows, testType, startDate, endDate) {
  return rows.some((r) => r.test === testType && r.date >= startDate && r.date <= endDate);
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    QUALIFYING_TEST_TYPE,
    parseTestCsvLine,
    splitTestCsvLines,
    parseUsDate,
    parseTestActivityCsv,
    hasQualifyingTest,
  };
}
