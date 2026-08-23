// Port of typing-grader/grader/matcher.py.
// Matches CSV rows to Classroom courses/assignments/students, and computes
// the grade per the 3-tier rule (see project memory:
// project_typing_grading_rule):
//   progress < 100%        -> 0
//   progress == 100% + turned in     -> full points
//   progress == 100% + not turned in -> 80% of points
// Ambiguous or unmatched student rows are flagged and skipped, never
// auto-resolved.

// TODO: port matching logic from matcher.py.

function computeGrade(progress, turnedIn, points) {
  if (progress < 100) return 0;
  return turnedIn ? points : Math.round(points * 0.8);
}

function matchStudent(firstName, lastName, roster) {
  throw new Error("not yet implemented");
}
