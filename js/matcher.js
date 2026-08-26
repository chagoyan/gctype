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
  };
}
