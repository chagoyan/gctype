// Port of typing-grader/grader/matcher.py.
// Matching logic: CSV rows -> Classroom roster entries, and the grading
// rule itself. See project memory "project_typing_grading_rule".

// Grade multiplier applied when Typing.com progress is 100% but the student
// never turned in the Classroom submission (e.g. the required screenshot).
// 0.8 of max points -> a full-credit lesson drops from an A to a B.
const NOT_TURNED_IN_FACTOR = 0.8;

/**
 * 100% progress is the only threshold that earns any credit at all.
 * Typing.com's own Grade/Stars/Accuracy/Speed are deliberately not
 * considered.
 */
function fullCredit(progressPct) {
  return progressPct >= 100;
}

/**
 * Grading rule:
 * - Progress < 100%: 0, regardless of turn-in status.
 * - Progress == 100% and turned in: full maxPoints.
 * - Progress == 100% but not turned in: NOT_TURNED_IN_FACTOR of maxPoints
 *   (e.g. the student completed the lesson but never submitted the
 *   screenshot proof in Classroom).
 */
function computeGrade(progressPct, maxPoints, turnedIn = true) {
  if (!fullCredit(progressPct)) return 0;
  if (turnedIn) return maxPoints;
  return Math.round(maxPoints * NOT_TURNED_IN_FACTOR);
}

/**
 * Whether a Classroom assignment's due date has fully elapsed as of `now`.
 * No due date at all (`dueDate` undefined/null) counts as always reached --
 * there's nothing to wait for. The cutoff is the end of the due date
 * (23:59:59.999 local time) regardless of whatever dueTime Classroom has
 * stored, matching how this tool always creates assignments with a fixed
 * 11:59 PM dueTime -- see classroomClient.js createCoursework.
 *
 * `dueDate` is the Classroom API shape: { year, month, day } (month is
 * 1-indexed, per the API, unlike JS Date).
 */
function isDueDateReached(dueDate, now = new Date()) {
  if (!dueDate) return true;
  const cutoff = new Date(dueDate.year, dueDate.month - 1, dueDate.day, 23, 59, 59, 999);
  return now.getTime() > cutoff.getTime();
}

function normalizeName(s) {
  return (s || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Match a CSV row's name against a Classroom roster.
 *
 * `roster` is an array of objects with `userId`, `givenName`, `familyName`.
 *
 * Returns { student, status } where status is one of:
 *   'matched'   -- exactly one roster entry matches first+last name
 *   'not_found' -- no roster entry matches
 *   'ambiguous' -- more than one roster entry matches (name collision) --
 *                  per the finalized design, these are flagged for manual
 *                  grading rather than auto-resolved.
 */
function matchStudent(firstName, lastName, roster) {
  const targetFirst = normalizeName(firstName);
  const targetLast = normalizeName(lastName);
  const matches = roster.filter(
    (s) =>
      normalizeName(s.givenName) === targetFirst &&
      normalizeName(s.familyName) === targetLast
  );

  if (matches.length === 1) return { student: matches[0], status: "matched" };
  if (matches.length === 0) return { student: null, status: "not_found" };
  return { student: null, status: "ambiguous" };
}

function studentNameKey(firstName, lastName) {
  return `${normalizeName(firstName)}|${normalizeName(lastName)}`;
}

/**
 * Typing.com lists each student under exactly one class, and never moves
 * them, so its export misses two real cases:
 *   - a student who switched periods (their rows keep the old class name)
 *   - a student enrolled in two of the teacher's periods (their rows only
 *     show up under one of them)
 * The Classroom roster is the source of truth for who's in a class, so this
 * finds roster students with no rows under `selectedClassName` whose name
 * does show up under some other class.
 *
 * Step 1 of 2 (no API calls): the caller fetches the rosters of every class
 * in `sourceClasses` and passes them to rowsListedElsewhere().
 *
 * `rows` is every parsed CSV row (any class). Works for both the Lesson
 * Details and Test Activity Details exports -- only firstName, lastName,
 * and className are read.
 *
 * Returns [{ key, userIds, sourceClasses }], one per distinct name. A name
 * shared by two students on the selected roster is one candidate carrying
 * both userIds (matchStudent flags it as ambiguous later anyway).
 */
function findStudentsListedElsewhere(rows, selectedClassName, roster) {
  const inSelected = new Set();
  const otherClassesByKey = new Map();
  for (const row of rows) {
    const key = studentNameKey(row.firstName, row.lastName);
    if (row.className === selectedClassName) {
      inSelected.add(key);
    } else {
      if (!otherClassesByKey.has(key)) otherClassesByKey.set(key, new Set());
      otherClassesByKey.get(key).add(row.className);
    }
  }

  const candidatesByKey = new Map();
  for (const student of roster) {
    const key = studentNameKey(student.givenName, student.familyName);
    if (inSelected.has(key) || !otherClassesByKey.has(key)) continue;
    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, { key, userIds: [], sourceClasses: [...otherClassesByKey.get(key)] });
    }
    candidatesByKey.get(key).userIds.push(student.userId);
  }
  return [...candidatesByKey.values()];
}

/**
 * Step 2 of 2: the rows that really belong to findStudentsListedElsewhere()'s
 * candidates, copied with className set to `selectedClassName` so they
 * group and grade alongside the class's own rows. Each copy keeps
 * `listedUnder` (the class Typing.com has them under) for the preview.
 *
 * `otherRosters` maps className -> roster array, or null when there's no
 * active Classroom course by that name (e.g. last semester's class).
 *
 * A source class is only trusted when every student on its roster with
 * that name is the same Classroom account (same userId) as on the selected
 * class's roster. That's what separates a two-period student (same account
 * on both rosters -- the rows are theirs) from two different students who
 * share a name (the rows belong to the other one -- never borrow them). A
 * source roster without the name at all means the student switched out.
 *
 * If more than one source class is trusted for the same name there's no
 * telling whose rows are whose, so rows from each are included but marked
 * `listedUnderAmbiguous` for manual grading.
 */
function rowsListedElsewhere(rows, selectedClassName, candidates, otherRosters) {
  const borrowed = [];
  for (const { key, userIds, sourceClasses } of candidates) {
    const trusted = sourceClasses.filter((className) => {
      const otherRoster = otherRosters.get(className);
      if (!otherRoster) return true;
      return otherRoster
        .filter((s) => studentNameKey(s.givenName, s.familyName) === key)
        .every((s) => userIds.includes(s.userId));
    });
    const ambiguous = trusted.length > 1;
    for (const row of rows) {
      if (!trusted.includes(row.className)) continue;
      if (studentNameKey(row.firstName, row.lastName) !== key) continue;
      borrowed.push({
        ...row,
        className: selectedClassName,
        listedUnder: row.className,
        listedUnderAmbiguous: ambiguous,
      });
    }
  }
  return borrowed;
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NOT_TURNED_IN_FACTOR,
    fullCredit,
    computeGrade,
    isDueDateReached,
    normalizeName,
    matchStudent,
    findStudentsListedElsewhere,
    rowsListedElsewhere,
  };
}
