// Default subject/body for the "you finished but forgot to turn in" email
// (see app.js's reminder section, gmailClient.js for the actual send).
// Ported in the same spirit as assignmentTemplate.js: a plain JS template
// string with placeholders, filled in with .replaceAll (not .replace --
// {firstName} can appear more than once). Editable live in the UI before
// sending, so these are just the defaults a fresh page loads with.

const REMINDER_SUBJECT_TEMPLATE = "Reminder: submit your Typing.com screenshot";

const REMINDER_BODY_TEMPLATE = `Hi {firstName},

Nice work -- you're at 100% progress on:
{lessons}

You just haven't submitted it in Google Classroom yet, so it can't be graded. Please turn in your GoFullPage screenshot as soon as you can.

Thanks!`;

/**
 * Fill in one candidate's placeholders. `candidate` is
 * { firstName, lessons: [string, ...] } -- see app.js's reminderCandidates().
 * `subjectTemplate`/`bodyTemplate` default to the constants above but are
 * accepted as arguments so the UI's live-edited text (not just the
 * built-in defaults) gets merged.
 */
function buildReminderEmail(
  candidate,
  subjectTemplate = REMINDER_SUBJECT_TEMPLATE,
  bodyTemplate = REMINDER_BODY_TEMPLATE
) {
  const lessonsList = candidate.lessons.map((l) => `- ${l}`).join("\n");
  const subject = subjectTemplate.replaceAll("{firstName}", candidate.firstName);
  const body = bodyTemplate
    .replaceAll("{firstName}", candidate.firstName)
    .replaceAll("{lessons}", lessonsList);
  return { subject, body };
}

/**
 * One entry per student -- deduped by email across every lesson group in
 * `plan` (app.js's currentPlan), not per lesson, so a student behind on two
 * lessons in this CSV gets a single email listing both instead of two
 * separate ones. Only students Classroom already has a submission for
 * (status "matched" or, before the assignment's due date, "not_yet_due")
 * and who are at 100% progress but not turned in qualify -- same
 * definition as the 80%-credit tier in app.js's buildPlan, just not graded
 * yet. A student with no email on file (classroom.profile.emails scope not
 * granted, or Classroom has none) is silently excluded rather than
 * producing an unsendable row.
 */
function reminderCandidates(plan) {
  const byEmail = new Map();
  for (const entry of plan) {
    for (const s of entry.students) {
      const eligible =
        (s.status === "matched" || s.status === "not_yet_due") &&
        s.progressPct >= 100 &&
        s.turnedIn === false &&
        s.email;
      if (!eligible) continue;
      if (!byEmail.has(s.email)) {
        byEmail.set(s.email, {
          email: s.email,
          firstName: s.firstName,
          lastName: s.lastName,
          lessons: [],
        });
      }
      byEmail.get(s.email).lessons.push(`${entry.className} — ${entry.lesson}`);
    }
  }
  return [...byEmail.values()];
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REMINDER_SUBJECT_TEMPLATE,
    REMINDER_BODY_TEMPLATE,
    buildReminderEmail,
    reminderCandidates,
  };
}
