// Port of typing-grader/grader/csv_parser.py.
// Parses the Typing.com CSV export in-browser. Raw CSV never leaves the
// client -- this is the core of the FERPA fix for the online migration.
// See: typing-autograder-online-migration-handoff.md
//
// Expected columns (from a Typing.com "Lesson Details" export):
// Username, First Name, Last Name, Class, Curriculum, Lesson, Screens Typed,
// Progress, Time Spent, Avg Acc, Avg Speed, Stars, Grade, Last Typed
//
// Only First Name, Last Name, Class, Lesson, and Progress are used.
// Everything else (Stars, Grade, Avg Acc, Avg Speed) is intentionally
// ignored -- grading is based on completion (Progress) only.
// See project memory "project_typing_grading_rule".

/**
 * Minimal RFC4180-ish CSV line splitter. Handles quoted fields (including
 * embedded commas, like Typing.com's "Learn the Keys 1: 1. J, F, and Space"
 * lesson titles) and "" escaped-quote sequences inside quoted fields.
 * Does not handle quoted fields containing literal newlines (Typing.com
 * exports don't produce those).
 */
function parseCsvLine(line) {
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

/**
 * Split raw CSV text into lines, stripping a UTF-8 BOM if present (mirrors
 * Python's `encoding="utf-8-sig"`) and tolerating both \r\n and \n.
 */
function splitCsvLines(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
}

/**
 * Parse Typing.com CSV export text into row objects.
 *
 * Each row: { firstName, lastName, className, lesson, progressPct (int) }.
 * Rows missing a name, class, or lesson are skipped (nothing to grade/match)
 * -- mirrors csv_parser.py's behavior exactly.
 *
 * @param {string} fileText - raw CSV file contents
 * @returns {Array<{firstName: string, lastName: string, className: string, lesson: string, progressPct: number}>}
 */
function parseTypingCsv(fileText) {
  const lines = splitCsvLines(fileText);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const colIndex = {};
  header.forEach((name, i) => {
    colIndex[name] = i;
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);

    const get = (col) => {
      const idx = colIndex[col];
      return idx === undefined ? "" : (fields[idx] || "").trim();
    };

    const first = get("First Name");
    const last = get("Last Name");
    const className = get("Class");
    const lesson = get("Lesson");
    const progressRaw = get("Progress").replace(/%$/, "");

    if (!(first && last && className && lesson)) {
      continue;
    }

    let progressPct = parseFloat(progressRaw);
    progressPct = Number.isFinite(progressPct) ? Math.trunc(progressPct) : 0;

    rows.push({
      firstName: first,
      lastName: last,
      className,
      lesson,
      progressPct,
    });
  }
  return rows;
}

/**
 * Group parsed rows by (className, lesson) pair. Each pair corresponds to
 * exactly one Classroom assignment, per the finalized 1:1
 * lesson-to-assignment design.
 *
 * Returns a Map keyed by a JSON-encoded [className, lesson] tuple (safe
 * even though both fields can contain spaces/commas) -> { className,
 * lesson, rows }.
 */
function groupByClassAndLesson(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.className, row.lesson]);
    if (!groups.has(key)) {
      groups.set(key, { className: row.className, lesson: row.lesson, rows: [] });
    }
    groups.get(key).rows.push(row);
  }
  return groups;
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCsvLine, splitCsvLines, parseTypingCsv, groupByClassAndLesson };
}
