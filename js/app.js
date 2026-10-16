// Entry point / view state management.
// Replaces the Flask routes (/upload, /preview/<id>, /submit/<id>) with
// client-side state transitions -- no server round-trip. See
// typing-grader/app.py's build_plan/upload/preview/submit for the logic
// this ports.

let classroomClient = null; // instantiated once auth is ready
let currentPlan = []; // array of group entries, see buildPlan() below
let currentCsvText = null; // raw CSV text, kept so re-picking a class can rebuild the plan
let currentGradeClass = null; // className the current plan/preview is scoped to

// Typing Test tab state (see buildTestPlan() and friends, below the Remind
// section) -- kept separate from the lesson-grading state above since it's
// a different CSV shape (Test Activity Details, not Lesson Details) and a
// different plan structure (one class+assignment at a time, not a list of
// class+lesson groups).
let currentTestCsvText = null;
let currentTestEntry = null; // the single plan object built by buildTestPlan()

// Which Grade sub-view to return to when the "Grade" nav tab is clicked --
// grading is now a multi-step flow (upload -> pick class -> preview ->
// results), so the tab should resume wherever the teacher left off instead
// of always restarting at upload.
const GRADE_VIEWS = new Set(["grade-upload", "grade-class-pick", "grade-preview", "results"]);
let gradeSubView = "grade-upload";

// Points assigned to an assignment the tool creates itself. Matches the
// point value already used on the manually-created Learn the Keys / Cross
// Curricular assignments (see typing-grader/app.py DEFAULT_MAX_POINTS).
const DEFAULT_MAX_POINTS = 20;

// Every assignment the tool creates is filed under this topic so it's easy
// to find and re-file/re-title by hand afterward.
const PENDING_TOPIC_NAME = "Pending";
// Gap between classes when creating assignments across multiple
// periods in the picker/test-create loops, on top of classroomFetch's
// own retry-with-backoff -- see the comments at each call site.
const CLASS_CREATE_DELAY_MS = 600;

// Per-browser checkbox preferences, remembered between visits.
const HIDE_GRADED_PREF = "gctype.hideFullyGraded";

// ---------------------------------------------------------------------
// Small view helpers
// ---------------------------------------------------------------------

// localStorage can be unavailable (private window, blocked site data), so
// both helpers fail quietly -- the checkbox just isn't remembered.
function loadPref(key) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

function showView(name) {
  for (const el of document.querySelectorAll(".view")) {
    el.hidden = el.id !== `view-${name}`;
  }
  if (GRADE_VIEWS.has(name)) gradeSubView = name;
  const activeTab = GRADE_VIEWS.has(name) ? "grade" : name === "test" ? "test" : "create";
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.nav === activeTab);
  }
}

function flash(message) {
  const el = document.getElementById("flash");
  const li = document.createElement("li");
  li.textContent = message;
  el.appendChild(li);
}

function clearFlash() {
  document.getElementById("flash").innerHTML = "";
}

/** Show a status line during a multi-step async operation (fetch/submit loops). */
function updateProgress(el, text) {
  el.hidden = false;
  el.textContent = text;
}

function hideProgress(el) {
  el.hidden = true;
  el.textContent = "";
}

// ---------------------------------------------------------------------
// build_plan port (typing-grader/app.py build_plan)
// ---------------------------------------------------------------------

/**
 * Distinct class names present in a CSV, in period order -- read entirely
 * client-side (no Classroom API calls) so the teacher can pick which one
 * class to grade before anything is fetched.
 */
function distinctClassNames(csvText) {
  const rows = parseTypingCsv(csvText);
  const names = [...new Set(rows.map((r) => r.className))];
  names.sort((a, b) => comparePeriodKeys(periodSortKey(a), periodSortKey(b)));
  return names;
}

/**
 * Parse a CSV and match every lesson group *for one class* against
 * Classroom, producing a full preview: which assignment matched, and for
 * each student in that group, their match status and computed grade.
 *
 * Scoped to a single class (selectedClassName) rather than every class in
 * the CSV -- grading used to build a plan across every class x lesson combo
 * in one pass, which could fire well over Classroom's per-minute request
 * quota on a CSV covering several periods. Picking one class first keeps
 * each run small and predictable.
 *
 * onProgress(current, total, lesson), if given, is called before each
 * group's Classroom lookups so the caller can show live progress.
 */
async function buildPlan(csvText, selectedClassName, onProgress) {
  // Canonicalize each row's lesson number against CURRICULUM before
  // grouping -- Typing.com has renumbered lessons as it restructured units
  // over time, so exported data can carry a stale number for a lesson that
  // still exists (see canonicalizeLesson), and grouping/matching both key
  // on the exact lesson string.
  const allRows = parseTypingCsv(csvText).map((row) => ({
    ...row,
    lesson: canonicalizeLesson(row.lesson),
  }));

  // The roster is needed before grouping, not just per group: students
  // who switched into this class, or who are in two of the teacher's
  // periods, are on this roster but Typing.com lists their rows under
  // another class -- see fetchRowsListedElsewhere. Fetched once here
  // rather than once per lesson group.
  const course = await classroomClient.findCourseByName(selectedClassName);
  const roster = course ? await classroomClient.getRoster(course.id) : null;
  let rows = allRows.filter((r) => r.className === selectedClassName);
  if (roster) {
    rows = rows.concat(await fetchRowsListedElsewhere(allRows, selectedClassName, roster));
  }
  const groups = groupByClassAndLesson(rows);

  const sortedGroups = [...groups.values()].sort((a, b) => {
    const byUnit = compareUnitKeys(unitSortKey(unitName(a.lesson)), unitSortKey(unitName(b.lesson)));
    if (byUnit !== 0) return byUnit;
    return compareNaturalKeys(naturalSortKey(a.lesson), naturalSortKey(b.lesson));
  });

  const plan = [];
  let done = 0;

  for (const group of sortedGroups) {
    done++;
    if (onProgress) onProgress(done, sortedGroups.length, group.lesson);

    const entry = {
      className: group.className,
      lesson: group.lesson,
      unit: unitName(group.lesson),
      course: null,
      coursework: null,
      courseError: null,
      courseworkError: null,
      students: [],
    };

    if (!course) {
      entry.courseError = `No active Classroom course named "${group.className}" found.`;
      plan.push(entry);
      continue;
    }
    entry.course = course;

    const coursework = await classroomClient.findCourseworkByTitle(course.id, group.lesson);
    if (!coursework) {
      entry.courseworkError = `No assignment titled "${group.lesson}" found in ${group.className}.`;
      plan.push(entry);
      continue;
    }
    entry.coursework = coursework;

    const submissions = await classroomClient.getSubmissions(course.id, coursework.id);
    const subsByUser = new Map(submissions.map((s) => [s.userId, s]));
    const maxPoints = coursework.maxPoints || 0;

    for (const row of group.rows) {
      let { student, status } = matchStudent(row.firstName, row.lastName, roster);
      if (status === "matched" && row.listedUnderAmbiguous) status = "listed_elsewhere_ambiguous";
      const studentEntry = {
        firstName: row.firstName,
        lastName: row.lastName,
        progressPct: row.progressPct,
        listedUnder: row.listedUnder || null,
        status,
        grade: null,
        existingGrade: null,
        submissionId: null,
        turnedIn: null,
        email: null,
      };
      if (status === "matched") {
        // Populated regardless of submission state below -- the reminder
        // feature (reminderCandidates()) needs it even though grading
        // itself doesn't. Empty string if the classroom.profile.emails
        // scope wasn't granted (see classroomClient.js's getRoster).
        studentEntry.email = student.email || null;
        const submission = subsByUser.get(student.userId);
        if (!submission) {
          // No submission record at all for this student (rare -- normally
          // Classroom creates one for every roster member as soon as
          // coursework exists). Leave ungraded rather than guessing.
          studentEntry.status = "no_submission";
        } else {
          const turnedIn = submission.state === "TURNED_IN" || submission.state === "RETURNED";
          studentEntry.submissionId = submission.id;
          studentEntry.turnedIn = turnedIn;
          // assignedGrade is absent/undefined until a grade has actually
          // been patched -- normalize to null so "no existing grade" and
          // "existing grade of 0" are distinguishable below.
          const existingGrade =
            submission.assignedGrade === undefined ? null : submission.assignedGrade;
          studentEntry.existingGrade = existingGrade;

          // Submitted + 100% complete grades immediately, due date or not.
          // Anything short of that (not turned in, or turned in but under
          // 100%) is held back -- not graded as 0 or 80% -- until the
          // assignment's due date has passed, so a student mid-lesson isn't
          // marked down for work that isn't due yet. See "resubmitted"
          // discussion in project memory: grading a submission before it's
          // turned in is also what caused Classroom to show it as
          // "resubmitted" once the student did turn it in.
          const fullyDone = turnedIn && fullCredit(row.progressPct);
          if (fullyDone || isDueDateReached(entry.coursework.dueDate)) {
            const computed = computeGrade(row.progressPct, maxPoints, turnedIn);
            studentEntry.grade = computed;
            // Same CSV row matched against a submission already carrying
            // this exact grade -- re-patching would be a no-op write to
            // Classroom. This is what caused already-graded students to
            // keep getting (re-)checked and resubmitted on every run of an
            // overlapping CSV. Only skip on an exact match: if the existing
            // grade differs from what's computed now (e.g. a student
            // resubmitted after being graded), leave status "matched" so
            // it's still selectable for a manual regrade.
            if (existingGrade !== null && existingGrade === computed) {
              studentEntry.status = "already_graded";
            }
          } else {
            studentEntry.status = "not_yet_due";
          }
        }
      }
      entry.students.push(studentEntry);
    }

    plan.push(entry);
  }

  return plan;
}

/**
 * Rows Typing.com lists under another class that belong to a student on
 * `roster` -- a student who switched into this class, or one in two of the
 * teacher's periods. Fetches only the rosters of classes where one of this
 * class's students' names actually shows up (usually none or one), so the
 * matcher can tell the same student apart from a different student who
 * shares the name. Shared by buildPlan and buildTestPlan; the matching
 * rules themselves live in matcher.js.
 */
async function fetchRowsListedElsewhere(allRows, selectedClassName, roster) {
  const candidates = findStudentsListedElsewhere(allRows, selectedClassName, roster);
  const otherRosters = new Map();
  for (const { sourceClasses } of candidates) {
    for (const className of sourceClasses) {
      if (otherRosters.has(className)) continue;
      const course = await classroomClient.findCourseByName(className);
      otherRosters.set(className, course ? await classroomClient.getRoster(course.id) : null);
    }
  }
  return rowsListedElsewhere(allRows, selectedClassName, candidates, otherRosters);
}

/**
 * An assignment with nothing left for this tool to grade: it exists in
 * Classroom, at least one student already has their grade, and nobody is
 * still waiting to be graded ("matched") or held until the due date
 * ("not_yet_due"). Rows needing manual grading (not on roster, etc.) don't
 * keep it showing -- the tool can't act on those anyway. Drives the "Hide
 * fully graded assignments" toggle.
 */
function isFullyGraded(entry) {
  if (!entry.coursework) return false;
  return (
    entry.students.some((s) => s.status === "already_graded") &&
    !entry.students.some((s) => s.status === "matched" || s.status === "not_yet_due")
  );
}

// ---------------------------------------------------------------------
// Preview rendering (typing-grader/templates/preview.html)
// ---------------------------------------------------------------------

const STATUS_LABELS = {
  matched: "Matched",
  no_submission: "Matched, but no submission record found — needs manual grading",
  ambiguous: "Ambiguous name match on roster — needs manual grading",
  not_found: "Not on this class's roster — needs manual grading (if they switched periods, grade them from their new class)",
  listed_elsewhere_ambiguous: "Typing.com lists this name under more than one other class — needs manual grading",
  not_yet_due: "Not yet due — waiting to grade incomplete/not-turned-in work",
  already_graded: "Already graded in Classroom — no change, skipped",
};

/**
 * Student name cell for both preview tables. Adds a note when the row came
 * from another class in the CSV, so it's clear why a student Typing.com
 * files elsewhere is being graded here.
 */
function studentNameCell(s) {
  const td = document.createElement("td");
  td.textContent = `${s.firstName} ${s.lastName}`;
  if (s.listedUnder) {
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = `Typing.com lists under ${s.listedUnder}`;
    td.appendChild(note);
  }
  return td;
}

// ---------------------------------------------------------------------
// "Create Assignments" picker (typing-grader/preview.html's ahead-of-time
// assignment form + typing-grader/app.py's create_assignment route)
// ---------------------------------------------------------------------

/**
 * Which classes were checked in a given checkbox-list container before this
 * (re)population, so a rebuild (e.g. after creating an assignment
 * re-matches the CSV) doesn't lose the teacher's selection -- same
 * "sticky" intent as the old single-select's `previous` handling. Generic
 * over `containerId` -- reused by both the "Create Assignments" class
 * picker (#ahead-class-list) and the "Typing Test" create picker
 * (#test-create-class-list), which are otherwise identical UI.
 */
function checkedClassesIn(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(
    (cb) => cb.value
  );
}

async function populateClassCheckboxList(containerId) {
  const list = document.getElementById(containerId);
  const previouslyChecked = new Set(checkedClassesIn(containerId));
  let courses;
  try {
    courses = await classroomClient.listActiveCourses();
  } catch (err) {
    flash(`Couldn't load your Classroom courses: ${err.message}`);
    return;
  }
  const names = [...new Set(courses.map((c) => c.name || ""))].sort((a, b) =>
    comparePeriodKeys(periodSortKey(a), periodSortKey(b))
  );
  list.innerHTML = "";
  for (const name of names) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    cb.checked = previouslyChecked.has(name);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    list.appendChild(label);
  }
}

/**
 * Full curriculum (not just what's in this CSV) for the Lesson dropdown,
 * plus a safety net for any lesson already in the current plan that
 * CURRICULUM doesn't cover -- see curriculumLessonGroups in curriculum.js.
 */
function populateAheadLessonPicker() {
  const select = document.getElementById("ahead-lesson");
  const groups = curriculumLessonGroups(currentPlan.map((e) => ({ unit: e.unit, lesson: e.lesson })));
  select.innerHTML = "";
  for (const [unit, lessons] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = unit;
    for (const lesson of lessons) {
      const opt = document.createElement("option");
      opt.value = lesson;
      opt.textContent = lesson;
      optgroup.appendChild(opt);
    }
    select.appendChild(optgroup);
  }
}

/** Create the assignment in one class; throws on failure, returns a status string on success/skip. */
async function createAssignmentInClass(className, { lesson, maxPoints, dueDateRaw, dueDate, asDraft }) {
  const course = await classroomClient.findCourseByName(className);
  if (!course) {
    return { ok: false, message: `No active Classroom course named "${className}" found.` };
  }

  // Refuse to create a second assignment with the same title in the same
  // course -- avoids duplicate-titled assignments that would make
  // grading's exact-title match ambiguous later.
  const existing = await classroomClient.findCourseworkByTitle(course.id, lesson);
  if (existing) {
    return {
      ok: false,
      message: `An assignment titled "${lesson}" already exists in ${className} — nothing created.`,
    };
  }

  const topic = await classroomClient.getOrCreateTopic(course.id, PENDING_TOPIC_NAME);
  await classroomClient.createCoursework(course.id, {
    title: lesson,
    description: buildAssignmentDescription(lesson),
    maxPoints,
    topicId: topic.topicId,
    dueDate,
    asDraft,
  });

  const dueNote = dueDateRaw ? `, due ${dueDateRaw}` : "";
  const draftNote = asDraft ? " as a draft" : "";
  return { ok: true, message: `Created "${lesson}" in ${className}${draftNote} (${maxPoints} pts${dueNote}).` };
}

async function createAssignmentFromPicker() {
  const classNames = checkedClassesIn("ahead-class-list");
  const lesson = document.getElementById("ahead-lesson").value;
  const pointsRaw = document.getElementById("ahead-points").value.trim();
  const maxPoints = pointsRaw ? parseInt(pointsRaw, 10) || DEFAULT_MAX_POINTS : DEFAULT_MAX_POINTS;
  const dueDateRaw = document.getElementById("ahead-due-date").value; // "YYYY-MM-DD" or ""
  // Parsed as local midnight, not UTC, so the date shown matches what was
  // typed regardless of timezone (a bare "new Date('YYYY-MM-DD')" parses
  // as UTC and can display a day off in the evening in US timezones).
  const dueDate = dueDateRaw ? new Date(`${dueDateRaw}T00:00:00`) : null;
  const asDraft = document.getElementById("ahead-draft").checked;

  clearFlash();
  if (classNames.length === 0 || !lesson) {
    flash("Missing class(es) or lesson for assignment creation.");
    return;
  }

  const btn = document.getElementById("create-assignment-btn");
  const progressEl = document.getElementById("create-progress");
  btn.disabled = true;
  try {
    // Created one class at a time (not in parallel) so one class's failure
    // (e.g. a duplicate title) doesn't race with or obscure another's, and
    // so flash messages come back in the same order the classes are listed.
    let done = 0;
    for (const className of classNames) {
      // A short gap between classes, on top of classroomClient's own
      // retry-with-backoff, so back-to-back topic+coursework writes across
      // classes don't land on Google's API in a tight burst (seen causing
      // a transient bare 500 "Internal error encountered." 2026-09-09).
      if (done > 0) await sleep(CLASS_CREATE_DELAY_MS);
      done++;
      updateProgress(progressEl, `Creating "${lesson}" in ${className}… (${done} of ${classNames.length})`);
      try {
        const result = await createAssignmentInClass(className, {
          lesson,
          maxPoints,
          dueDateRaw,
          dueDate,
          asDraft,
        });
        flash(result.message);
      } catch (err) {
        console.error(err);
        flash(`Failed to create "${lesson}" in ${className}: ${err.message}`);
      }
    }
  } finally {
    hideProgress(progressEl);
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Grade -- step 2, class picker (typing-grader/app.py had no equivalent --
// the Flask version's single request budget never needed this)
// ---------------------------------------------------------------------

function populateGradeClassPicker(classNames) {
  const select = document.getElementById("grade-class-select");
  select.innerHTML = "";
  for (const name of classNames) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  if (currentGradeClass && classNames.includes(currentGradeClass)) {
    select.value = currentGradeClass;
  }
}

async function loadGradeClass() {
  const select = document.getElementById("grade-class-select");
  const className = select.value;
  if (!className) return;

  const btn = document.getElementById("grade-load-class-btn");
  const progressEl = document.getElementById("grade-class-progress");
  clearFlash();
  btn.disabled = true;
  select.disabled = true;

  try {
    currentGradeClass = className;
    currentPlan = await buildPlan(currentCsvText, className, (done, total, lesson) => {
      updateProgress(progressEl, `Fetching "${lesson}" from Classroom… (${done} of ${total})`);
    });
    hideProgress(progressEl);
    renderPreview();
  } catch (err) {
    console.error(err);
    hideProgress(progressEl);
    flash(`Couldn't build a grading plan for ${className}: ${err.message}`);
  } finally {
    btn.disabled = false;
    select.disabled = false;
  }
}

function renderPreview() {
  const container = document.getElementById("groups-container");
  container.innerHTML = "";

  document.getElementById("grade-preview-class").textContent = currentGradeClass;

  currentPlan.forEach((entry, entryIdx) => {
    const section = document.createElement("section");
    section.className = "group";
    section.dataset.unit = entry.unit;
    section.dataset.lesson = entry.lesson;
    section.dataset.fullyGraded = String(isFullyGraded(entry));

    const heading = document.createElement("h2");
    heading.textContent = `${entry.className} — ${entry.lesson}`;
    if (entry.coursework) {
      const badge = document.createElement("span");
      badge.className = "points-badge";
      badge.textContent = `${entry.coursework.maxPoints || 0} pts`;
      heading.appendChild(badge);
    }
    section.appendChild(heading);

    if (entry.courseError) {
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = entry.courseError;
      section.appendChild(p);
    } else if (entry.courseworkError) {
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = entry.courseworkError;
      section.appendChild(p);
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.textContent = 'Use "Create Assignments" above to create it.';
      section.appendChild(hint);
    } else {
      const table = document.createElement("table");
      table.innerHTML =
        "<tr><th>Grade?</th><th>Student</th><th>Progress</th><th>Turned in?</th><th>Computed grade</th><th>Status</th></tr>";

      entry.students.forEach((s, studentIdx) => {
        const tr = document.createElement("tr");
        tr.className = `status-${s.status}`;

        const tdCheck = document.createElement("td");
        if (s.status === "matched" && s.submissionId) {
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.dataset.entryIdx = String(entryIdx);
          cb.dataset.studentIdx = String(studentIdx);
          // Pre-check only full-credit rows (100% progress AND turned in).
          // 100%-progress-but-not-turned-in (80%-credit) rows are left
          // unchecked on purpose -- pre-checking them made it too easy to
          // submit-all without noticing, undercutting the whole point of
          // the 80% tier as a turn-in incentive. Changed 2026-08-22 after
          // Manuel caught this live; also fixed in the Flask app's
          // preview.html to match.
          cb.checked = s.progressPct >= 100 && s.turnedIn === true;
          tdCheck.appendChild(cb);
        } else {
          tdCheck.textContent = "—";
        }
        tr.appendChild(tdCheck);

        tr.appendChild(studentNameCell(s));

        const tdProgress = document.createElement("td");
        tdProgress.textContent = `${s.progressPct}%`;
        tr.appendChild(tdProgress);

        const tdTurnedIn = document.createElement("td");
        tdTurnedIn.textContent = s.turnedIn === null ? "—" : s.turnedIn ? "Yes" : "No";
        tr.appendChild(tdTurnedIn);

        const tdGrade = document.createElement("td");
        tdGrade.textContent = s.grade === null ? "—" : String(s.grade);
        tr.appendChild(tdGrade);

        const tdStatus = document.createElement("td");
        tdStatus.textContent = STATUS_LABELS[s.status] || "";
        tr.appendChild(tdStatus);

        table.appendChild(tr);
      });

      section.appendChild(table);
    }

    container.appendChild(section);
  });

  setupFilters();
  renderReminderSection();
  showView("grade-preview");
}

// ---------------------------------------------------------------------
// Unit / Lesson filters (ported from preview.html's inline script; the
// class dimension moved to a fetch-time picker, see loadGradeClass)
// ---------------------------------------------------------------------

function setupFilters() {
  const unitSelect = document.getElementById("filter-unit");
  const lessonSelect = document.getElementById("filter-lesson");
  const hideGraded = document.getElementById("filter-hide-graded");
  const allGradedNote = document.getElementById("all-graded-note");
  const sections = Array.from(document.querySelectorAll("#groups-container .group"));

  hideGraded.checked = loadPref(HIDE_GRADED_PREF);
  const gradedCount = sections.filter((s) => s.dataset.fullyGraded === "true").length;
  document.getElementById("hide-graded-count").textContent = `(${gradedCount})`;

  // Applied before the Unit/Lesson filters, so their dropdowns only offer
  // units and lessons that still have something showing.
  const shownByToggle = (s) => !hideGraded.checked || s.dataset.fullyGraded !== "true";

  function uniqueValues(attr, matches) {
    const seen = new Set();
    const values = [];
    for (const s of sections) {
      const v = s.dataset[attr];
      if (shownByToggle(s) && matches(s) && !seen.has(v)) {
        seen.add(v);
        values.push(v);
      }
    }
    return values;
  }

  function fillSelect(select, values, placeholder) {
    const previous = select.value;
    select.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = placeholder;
    select.appendChild(allOption);
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    }
    const stillValid = Array.from(select.options).some((o) => o.value === previous);
    select.value = stillValid ? previous : "";
  }

  function populateLessons() {
    const unit = unitSelect.value;
    fillSelect(
      lessonSelect,
      uniqueValues("lesson", (s) => unit === "" || s.dataset.unit === unit),
      "All lessons"
    );
  }

  function applyFilter() {
    const unit = unitSelect.value;
    const lesson = lessonSelect.value;
    for (const s of sections) {
      const match =
        shownByToggle(s) &&
        (unit === "" || s.dataset.unit === unit) &&
        (lesson === "" || s.dataset.lesson === lesson);
      s.style.display = match ? "" : "none";
    }
    allGradedNote.hidden = !(sections.length > 0 && !sections.some(shownByToggle));
  }

  fillSelect(unitSelect, uniqueValues("unit", () => true), "All units");
  unitSelect.value = "";

  unitSelect.onchange = () => {
    populateLessons();
    applyFilter();
  };
  lessonSelect.onchange = applyFilter;
  hideGraded.onchange = () => {
    savePref(HIDE_GRADED_PREF, hideGraded.checked);
    fillSelect(unitSelect, uniqueValues("unit", () => true), "All units");
    populateLessons();
    applyFilter();
  };

  populateLessons();
  applyFilter();
}

// ---------------------------------------------------------------------
// Submit (typing-grader/app.py submit route)
// ---------------------------------------------------------------------

async function submitCheckedGrades() {
  // Only rows currently visible under the Unit/Lesson filter get submitted
  // -- a checkbox left checked inside a filtered-out group (style.display
  // "none", set by applyFilter above) is not included, so switching the
  // filter view narrows what "Submit" actually sends.
  const checkboxes = Array.from(
    document.querySelectorAll('#groups-container input[type="checkbox"]:checked')
  ).filter((cb) => {
    const group = cb.closest(".group");
    return group && group.style.display !== "none";
  });

  const btn = document.getElementById("submit-btn");
  const progressEl = document.getElementById("submit-progress");
  btn.disabled = true;

  const results = [];
  let done = 0;
  try {
    for (const cb of checkboxes) {
      const entry = currentPlan[Number(cb.dataset.entryIdx)];
      const student = entry.students[Number(cb.dataset.studentIdx)];
      if (!entry.course || !entry.coursework) continue;
      if (student.status !== "matched" || !student.submissionId) continue;

      done++;
      updateProgress(
        progressEl,
        `Grading ${student.firstName} ${student.lastName} — ${entry.lesson}… (${done} of ${checkboxes.length})`
      );

      try {
        await classroomClient.patchGrade(entry.course.id, entry.coursework.id, student.submissionId, student.grade);
        results.push({
          name: `${student.firstName} ${student.lastName}`,
          lesson: entry.lesson,
          grade: student.grade,
          ok: true,
          error: null,
        });
      } catch (err) {
        results.push({
          name: `${student.firstName} ${student.lastName}`,
          lesson: entry.lesson,
          grade: student.grade,
          ok: false,
          error: err.message,
        });
      }
    }
  } finally {
    hideProgress(progressEl);
    btn.disabled = false;
  }

  currentPlan = [];
  renderResults(results);
}

function renderResults(results) {
  const container = document.getElementById("results-container");
  container.innerHTML = "";

  if (results.length === 0) {
    const p = document.createElement("p");
    p.textContent = "Nothing was submitted — no rows were checked.";
    container.appendChild(p);
  } else {
    const table = document.createElement("table");
    table.innerHTML = "<tr><th>Student</th><th>Lesson</th><th>Grade</th><th>Result</th></tr>";
    for (const r of results) {
      const tr = document.createElement("tr");
      tr.className = r.ok ? "ok" : "fail";
      tr.innerHTML = `<td>${r.name}</td><td>${r.lesson}</td><td>${r.grade}</td><td>${
        r.ok ? "Graded" : `Failed: ${r.error}`
      }</td>`;
      table.appendChild(tr);
    }
    container.appendChild(table);
  }

  showView("results");
}

// ---------------------------------------------------------------------
// Remind students who forgot to turn in. There's no Classroom API for a
// private per-student comment (checked live 2026-08-31 -- the
// studentSubmissions resource only has get/list/modifyAttachments/patch/
// reclaim/return/turnIn), so this sends a direct email instead, via
// gmailClient.js. Nothing sends until the teacher clicks "Send reminders".
// ---------------------------------------------------------------------

// Built by renderReminderSection() from currentPlan; sendReminders() reads
// from this (indexed by the checkbox's data-idx) rather than currentPlan
// directly, since submitCheckedGrades() clears currentPlan once grades are
// submitted but the reminder section should keep working independently.
let currentReminderCandidates = [];

// reminderCandidates() itself lives in reminderTemplate.js, not here --
// it's pure plan-crunching logic with no DOM/network dependency, so it's
// kept alongside buildReminderEmail() where the node test runner (see
// test/run_tests.js) can exercise it directly, same as buildAssignmentDescription.

/** (Re)builds the reminder section from currentPlan; called at the end of renderPreview(). */
function renderReminderSection() {
  const section = document.getElementById("remind-section");
  document.getElementById("remind-results-container").innerHTML = "";

  currentReminderCandidates = reminderCandidates(currentPlan);
  if (currentReminderCandidates.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  // Only fill in the default copy the first time -- if the teacher already
  // edited the subject/body, a later renderPreview() (e.g. after creating
  // an assignment triggers a re-match) shouldn't overwrite their edits.
  const subjectInput = document.getElementById("remind-subject");
  const bodyInput = document.getElementById("remind-body");
  if (!subjectInput.dataset.touched) {
    subjectInput.value = REMINDER_SUBJECT_TEMPLATE;
    subjectInput.addEventListener("input", () => (subjectInput.dataset.touched = "1"), { once: true });
  }
  if (!bodyInput.dataset.touched) {
    bodyInput.value = REMINDER_BODY_TEMPLATE;
    bodyInput.addEventListener("input", () => (bodyInput.dataset.touched = "1"), { once: true });
  }

  const listContainer = document.getElementById("remind-list-container");
  listContainer.innerHTML = "";
  const table = document.createElement("table");
  table.innerHTML =
    "<tr><th>Send?</th><th>Student</th><th>Email</th><th>Done, not turned in</th></tr>";
  currentReminderCandidates.forEach((c, idx) => {
    const tr = document.createElement("tr");

    const tdCheck = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.idx = String(idx);
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdName = document.createElement("td");
    tdName.textContent = `${c.firstName} ${c.lastName}`;
    tr.appendChild(tdName);

    const tdEmail = document.createElement("td");
    tdEmail.textContent = c.email;
    tr.appendChild(tdEmail);

    const tdLessons = document.createElement("td");
    tdLessons.textContent = c.lessons.join("; ");
    tr.appendChild(tdLessons);

    table.appendChild(tr);
  });
  listContainer.appendChild(table);
}

async function sendReminders() {
  const checkboxes = Array.from(
    document.querySelectorAll('#remind-list-container input[type="checkbox"]:checked')
  );
  if (checkboxes.length === 0) {
    flash("No reminder rows checked.");
    return;
  }

  const subjectTemplate = document.getElementById("remind-subject").value;
  const bodyTemplate = document.getElementById("remind-body").value;
  const btn = document.getElementById("send-reminders-btn");
  const progressEl = document.getElementById("remind-progress");
  btn.disabled = true;

  const results = [];
  let done = 0;
  try {
    // One at a time (not in parallel) -- same reasoning as
    // createAssignmentFromPicker: keeps progress reporting accurate and
    // avoids bursting past Gmail's send rate limit.
    for (const cb of checkboxes) {
      const candidate = currentReminderCandidates[Number(cb.dataset.idx)];
      done++;
      updateProgress(
        progressEl,
        `Emailing ${candidate.firstName} ${candidate.lastName}… (${done} of ${checkboxes.length})`
      );
      const { subject, body } = buildReminderEmail(candidate, subjectTemplate, bodyTemplate);
      try {
        await sendEmail(candidate.email, subject, body);
        results.push({ name: `${candidate.firstName} ${candidate.lastName}`, ok: true, error: null });
      } catch (err) {
        console.error(err);
        results.push({ name: `${candidate.firstName} ${candidate.lastName}`, ok: false, error: err.message });
      }
    }
  } finally {
    hideProgress(progressEl);
    btn.disabled = false;
  }

  renderReminderResults(results);
}

function renderReminderResults(results) {
  const container = document.getElementById("remind-results-container");
  container.innerHTML = "";
  const table = document.createElement("table");
  table.innerHTML = "<tr><th>Student</th><th>Result</th></tr>";
  for (const r of results) {
    const tr = document.createElement("tr");
    tr.className = r.ok ? "ok" : "fail";
    tr.innerHTML = `<td>${r.name}</td><td>${r.ok ? "Sent" : `Failed: ${r.error}`}</td>`;
    table.appendChild(tr);
  }
  container.appendChild(table);
}

// ---------------------------------------------------------------------
// Typing Test tab: periodic "did they take a 3 Minute Typing Test"
// checkpoints (start of year, end of each quarter, etc.), distinct from
// the Lesson-based Grade tab above. Design settled with Manuel 2026-08-31:
// - CSV shape is Typing.com's "Test Activity Details" export (see
//   testCsvParser.js), not "Lesson Details" -- no Lesson/Progress columns.
// - Only "3 Minute Typing Test" rows count (QUALIFYING_TEST_TYPE).
// - A student qualifies if ANY such row falls inside a teacher-chosen
//   date window -- the *first* qualifying date is what's shown, but
//   grading itself is pass/fail (participation), not tied to a specific
//   attempt's score.
// - Assignment title is "Typing Test Results {number}" (see
//   testTemplate.js) -- the teacher supplies the number, so they can
//   create as many checkpoints as they want (unlike lesson assignments,
//   which are 1:1 with a fixed CURRICULUM title).
// - Grading tiers are identical in shape to the lesson rule: qualifying
//   test + turned in (screenshot proof) = full credit; qualifying test but
//   not turned in = 80%; no qualifying test once the window/due-date has
//   passed = 0. Reuses computeGrade/isDueDateReached/matchStudent from
//   matcher.js unchanged -- "took a qualifying test" just stands in for
//   "progressPct >= 100".
// ---------------------------------------------------------------------

function showTestStep(step) {
  document.getElementById("test-grade-upload-step").hidden = step !== "upload";
  document.getElementById("test-grade-class-step").hidden = step !== "class";
  document.getElementById("test-preview-step").hidden = step !== "preview";
  document.getElementById("test-results-step").hidden = step !== "results";
}

function formatDateLabel(d) {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Distinct class names present in a Test Activity Details CSV, in period order -- mirrors distinctClassNames() for the Lesson CSV. */
function distinctTestClassNames(csvText) {
  const rows = parseTestActivityCsv(csvText);
  const names = [...new Set(rows.map((r) => r.className))];
  names.sort((a, b) => comparePeriodKeys(periodSortKey(a), periodSortKey(b)));
  return names;
}

function populateTestClassPicker(classNames) {
  const select = document.getElementById("test-class-select");
  select.innerHTML = "";
  for (const name of classNames) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
}

/**
 * Build the grading plan for one class + one "Typing Test Results
 * {number}" assignment + one [startDate, endDate] window (both local-
 * midnight Dates, inclusive). Structurally a single entry, not a list of
 * groups like buildPlan() -- there's only ever one assignment in play here.
 */
async function buildTestPlan(csvText, selectedClassName, number, startDate, endDate) {
  const allRows = parseTestActivityCsv(csvText);
  let classRows = allRows.filter((r) => r.className === selectedClassName);
  const title = buildTestAssignmentTitle(number);

  const entry = {
    className: selectedClassName,
    title,
    startDate,
    endDate,
    course: null,
    coursework: null,
    courseError: null,
    courseworkError: null,
    students: [],
  };

  const course = await classroomClient.findCourseByName(selectedClassName);
  if (!course) {
    entry.courseError = `No active Classroom course named "${selectedClassName}" found.`;
    return entry;
  }
  entry.course = course;

  const coursework = await classroomClient.findCourseworkByTitle(course.id, title);
  if (!coursework) {
    entry.courseworkError = `No assignment titled "${title}" found in ${selectedClassName}.`;
    return entry;
  }
  entry.coursework = coursework;

  const roster = await classroomClient.getRoster(course.id);
  // Students who switched into this class or are in two of the teacher's
  // periods -- see buildPlan / fetchRowsListedElsewhere.
  classRows = classRows.concat(await fetchRowsListedElsewhere(allRows, selectedClassName, roster));
  const submissions = await classroomClient.getSubmissions(course.id, coursework.id);
  const subsByUser = new Map(submissions.map((s) => [s.userId, s]));
  const maxPoints = coursework.maxPoints || 0;

  // One group of rows per distinct student actually present in this
  // class's CSV rows -- a roster student with zero rows at all (took
  // nothing all period) never surfaces here, same limitation buildPlan()
  // already has for lessons: nothing to grade without CSV data for them.
  const rowsByStudent = new Map();
  for (const row of classRows) {
    const key = `${row.firstName}|${row.lastName}`;
    if (!rowsByStudent.has(key)) rowsByStudent.set(key, []);
    rowsByStudent.get(key).push(row);
  }

  for (const studentRows of rowsByStudent.values()) {
    const { firstName, lastName } = studentRows[0];
    let { student, status } = matchStudent(firstName, lastName, roster);
    if (status === "matched" && studentRows.some((r) => r.listedUnderAmbiguous)) {
      status = "listed_elsewhere_ambiguous";
    }
    const tookQualifyingTest = hasQualifyingTest(studentRows, QUALIFYING_TEST_TYPE, startDate, endDate);
    const listedUnder = [...new Set(studentRows.map((r) => r.listedUnder).filter(Boolean))].join(", ");

    const studentEntry = {
      firstName,
      lastName,
      tookQualifyingTest,
      listedUnder: listedUnder || null,
      status,
      grade: null,
      existingGrade: null,
      submissionId: null,
      turnedIn: null,
    };

    if (status === "matched") {
      const submission = subsByUser.get(student.userId);
      if (!submission) {
        studentEntry.status = "no_submission";
      } else {
        const turnedIn = submission.state === "TURNED_IN" || submission.state === "RETURNED";
        studentEntry.submissionId = submission.id;
        studentEntry.turnedIn = turnedIn;
        const existingGrade = submission.assignedGrade === undefined ? null : submission.assignedGrade;
        studentEntry.existingGrade = existingGrade;

        // Same immediate-vs-held-back timing as buildPlan(): a qualifying
        // test + turn-in grades right away regardless of due date; anything
        // short of that waits for the due date so a student who hasn't had
        // their checkpoint window close yet isn't marked down early.
        const fullyDone = turnedIn && tookQualifyingTest;
        if (fullyDone || isDueDateReached(entry.coursework.dueDate)) {
          const computed = computeGrade(tookQualifyingTest ? 100 : 0, maxPoints, turnedIn);
          studentEntry.grade = computed;
          // Same no-op-write skip as the lesson grader (see already_graded
          // in buildPlan) -- avoids re-patching a grade Classroom already
          // has, which is exactly the kind of repeat-checkpoint churn this
          // feature is prone to.
          if (existingGrade !== null && existingGrade === computed) {
            studentEntry.status = "already_graded";
          }
        } else {
          studentEntry.status = "not_yet_due";
        }
      }
    }
    entry.students.push(studentEntry);
  }

  entry.students.sort((a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`)
  );

  return entry;
}

async function loadTestClass() {
  const select = document.getElementById("test-class-select");
  const className = select.value;
  const number = document.getElementById("test-grade-number").value.trim();
  const startRaw = document.getElementById("test-start-date").value;
  const endRaw = document.getElementById("test-end-date").value;

  clearFlash();
  if (!className || !number || !startRaw || !endRaw) {
    flash("Pick a class and fill in Number, Start date, and End date.");
    return;
  }
  // Parsed as local midnight, not UTC -- same reasoning as the "Create
  // Assignments" due-date field (see createAssignmentFromPicker).
  const startDate = new Date(`${startRaw}T00:00:00`);
  const endDate = new Date(`${endRaw}T00:00:00`);
  if (startDate > endDate) {
    flash("Start date must be on or before end date.");
    return;
  }

  const btn = document.getElementById("test-load-btn");
  const progressEl = document.getElementById("test-class-progress");
  btn.disabled = true;
  try {
    updateProgress(progressEl, `Fetching "${buildTestAssignmentTitle(number)}" from Classroom…`);
    currentTestEntry = await buildTestPlan(currentTestCsvText, className, number, startDate, endDate);
    hideProgress(progressEl);
    renderTestPreview(currentTestEntry);
  } catch (err) {
    console.error(err);
    hideProgress(progressEl);
    flash(`Couldn't build a grading plan for ${className}: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderTestPreview(entry) {
  document.getElementById("test-preview-class").textContent = entry.className;
  document.getElementById("test-preview-range").textContent =
    `${entry.title} — ${formatDateLabel(entry.startDate)} to ${formatDateLabel(entry.endDate)}`;

  const container = document.getElementById("test-groups-container");
  container.innerHTML = "";

  if (entry.courseError) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = entry.courseError;
    container.appendChild(p);
  } else if (entry.courseworkError) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = entry.courseworkError;
    container.appendChild(p);
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = 'Use "Create assignment" above to create it.';
    container.appendChild(hint);
  } else {
    const table = document.createElement("table");
    table.innerHTML =
      "<tr><th>Grade?</th><th>Student</th><th>Took qualifying test?</th><th>Turned in?</th><th>Computed grade</th><th>Status</th></tr>";

    entry.students.forEach((s, idx) => {
      const tr = document.createElement("tr");
      tr.className = `status-${s.status}`;

      const tdCheck = document.createElement("td");
      if (s.status === "matched" && s.submissionId) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.dataset.idx = String(idx);
        // Same pre-check rule as lessons: only the full-credit case
        // (qualifying test + turned in) is pre-checked -- see the
        // 2026-08-22 history note on buildPlan's checkbox for why an
        // 80%-credit row is left for a manual decision instead.
        cb.checked = s.tookQualifyingTest === true && s.turnedIn === true;
        tdCheck.appendChild(cb);
      } else {
        tdCheck.textContent = "—";
      }
      tr.appendChild(tdCheck);

      tr.appendChild(studentNameCell(s));

      const tdTook = document.createElement("td");
      tdTook.textContent = s.tookQualifyingTest ? "Yes" : "No";
      tr.appendChild(tdTook);

      const tdTurnedIn = document.createElement("td");
      tdTurnedIn.textContent = s.turnedIn === null ? "—" : s.turnedIn ? "Yes" : "No";
      tr.appendChild(tdTurnedIn);

      const tdGrade = document.createElement("td");
      tdGrade.textContent = s.grade === null ? "—" : String(s.grade);
      tr.appendChild(tdGrade);

      const tdStatus = document.createElement("td");
      tdStatus.textContent = STATUS_LABELS[s.status] || "";
      tr.appendChild(tdStatus);

      table.appendChild(tr);
    });

    container.appendChild(table);
  }

  showTestStep("preview");
}

async function submitCheckedTestGrades() {
  const checkboxes = Array.from(
    document.querySelectorAll('#test-groups-container input[type="checkbox"]:checked')
  );
  const entry = currentTestEntry;
  const btn = document.getElementById("test-submit-btn");
  const progressEl = document.getElementById("test-submit-progress");
  btn.disabled = true;

  const results = [];
  let done = 0;
  try {
    for (const cb of checkboxes) {
      const student = entry.students[Number(cb.dataset.idx)];
      if (!entry.course || !entry.coursework) continue;
      if (student.status !== "matched" || !student.submissionId) continue;

      done++;
      updateProgress(
        progressEl,
        `Grading ${student.firstName} ${student.lastName}… (${done} of ${checkboxes.length})`
      );

      try {
        await classroomClient.patchGrade(entry.course.id, entry.coursework.id, student.submissionId, student.grade);
        results.push({
          name: `${student.firstName} ${student.lastName}`,
          grade: student.grade,
          ok: true,
          error: null,
        });
      } catch (err) {
        results.push({
          name: `${student.firstName} ${student.lastName}`,
          grade: student.grade,
          ok: false,
          error: err.message,
        });
      }
    }
  } finally {
    hideProgress(progressEl);
    btn.disabled = false;
  }

  currentTestEntry = null;
  renderTestResults(results);
}

function renderTestResults(results) {
  const container = document.getElementById("test-results-container");
  container.innerHTML = "";

  if (results.length === 0) {
    const p = document.createElement("p");
    p.textContent = "Nothing was submitted — no rows were checked.";
    container.appendChild(p);
  } else {
    const table = document.createElement("table");
    table.innerHTML = "<tr><th>Student</th><th>Grade</th><th>Result</th></tr>";
    for (const r of results) {
      const tr = document.createElement("tr");
      tr.className = r.ok ? "ok" : "fail";
      tr.innerHTML = `<td>${r.name}</td><td>${r.grade}</td><td>${
        r.ok ? "Graded" : `Failed: ${r.error}`
      }</td>`;
      table.appendChild(tr);
    }
    container.appendChild(table);
  }

  showTestStep("results");
}

/** Create one "Typing Test Results {number}" assignment in one class; mirrors createAssignmentInClass(). */
async function createTestAssignmentInClass(className, { number, maxPoints, dueDateRaw, dueDate, asDraft }) {
  const course = await classroomClient.findCourseByName(className);
  if (!course) {
    return { ok: false, message: `No active Classroom course named "${className}" found.` };
  }

  const title = buildTestAssignmentTitle(number);
  const existing = await classroomClient.findCourseworkByTitle(course.id, title);
  if (existing) {
    return {
      ok: false,
      message: `An assignment titled "${title}" already exists in ${className} — nothing created.`,
    };
  }

  const topic = await classroomClient.getOrCreateTopic(course.id, PENDING_TOPIC_NAME);
  await classroomClient.createCoursework(course.id, {
    title,
    description: buildTestAssignmentDescription(number),
    maxPoints,
    topicId: topic.topicId,
    dueDate,
    asDraft,
  });

  const dueNote = dueDateRaw ? `, due ${dueDateRaw}` : "";
  const draftNote = asDraft ? " as a draft" : "";
  return { ok: true, message: `Created "${title}" in ${className}${draftNote} (${maxPoints} pts${dueNote}).` };
}

async function createTestAssignmentFromForm() {
  const classNames = checkedClassesIn("test-create-class-list");
  const number = document.getElementById("test-create-number").value.trim();
  const pointsRaw = document.getElementById("test-create-points").value.trim();
  const maxPoints = pointsRaw ? parseInt(pointsRaw, 10) || DEFAULT_MAX_POINTS : DEFAULT_MAX_POINTS;
  const dueDateRaw = document.getElementById("test-create-due-date").value;
  const dueDate = dueDateRaw ? new Date(`${dueDateRaw}T00:00:00`) : null;
  const asDraft = document.getElementById("test-create-draft").checked;

  clearFlash();
  if (classNames.length === 0 || !number) {
    flash("Missing class(es) or number for the typing test assignment.");
    return;
  }

  const btn = document.getElementById("test-create-btn");
  const progressEl = document.getElementById("test-create-progress");
  const title = buildTestAssignmentTitle(number);
  btn.disabled = true;
  try {
    // One class at a time, same reasoning as createAssignmentFromPicker:
    // keeps progress reporting accurate and flash messages in class order.
    let done = 0;
    for (const className of classNames) {
      // See the matching comment in createAssignmentFromPicker.
      if (done > 0) await sleep(CLASS_CREATE_DELAY_MS);
      done++;
      updateProgress(progressEl, `Creating "${title}" in ${className}… (${done} of ${classNames.length})`);
      try {
        const result = await createTestAssignmentInClass(className, {
          number,
          maxPoints,
          dueDateRaw,
          dueDate,
          asDraft,
        });
        flash(result.message);
      } catch (err) {
        console.error(err);
        flash(`Failed to create "${title}" in ${className}: ${err.message}`);
      }
    }
  } finally {
    hideProgress(progressEl);
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const authStatus = document.getElementById("auth-status");
  const signinBtn = document.getElementById("signin-btn");

  function renderSignedIn() {
    authStatus.textContent = "Signed in";
    signinBtn.textContent = "Re-authenticate";
    if (!classroomClient) classroomClient = new ClassroomClient();
  }

  function renderSignedOut() {
    authStatus.textContent = "";
    signinBtn.textContent = "Sign in with Google";
  }

  // initAuth() depends on the Google Identity Services script (loaded async
  // from accounts.google.com in index.html's <head>); a slow network or a
  // blocked request means `google` isn't defined yet and this throws. Catch
  // it here so the rest of this handler -- all the button/nav wiring below
  // -- still runs and the page stays usable (sign-in just won't work until
  // reloaded with the script available).
  try {
    initAuth(
      (token) => renderSignedIn(),
      (err) => {
        renderSignedOut();
        if (err && err.type && err.type !== "popup_closed") {
          console.warn("Google auth error:", err);
        }
      }
    );
  } catch (err) {
    console.error("Couldn't initialize Google sign-in:", err);
    flash("Couldn't load Google sign-in. Check your connection and reload the page.");
  }

  signinBtn.addEventListener("click", signIn);

  document.getElementById("csv-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    clearFlash();

    if (!isSignedIn()) {
      flash("Sign in with Google first.");
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        currentCsvText = reader.result;
        const classNames = distinctClassNames(currentCsvText);
        if (classNames.length === 0) {
          flash("No usable rows found in that CSV (need First Name, Last Name, Class, and Lesson columns).");
          return;
        }
        populateGradeClassPicker(classNames);
        showView("grade-class-pick");
      } catch (err) {
        console.error(err);
        flash(`Couldn't read that CSV: ${err.message}`);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("grade-load-class-btn").addEventListener("click", loadGradeClass);
  document.getElementById("submit-btn").addEventListener("click", submitCheckedGrades);
  document.getElementById("send-reminders-btn").addEventListener("click", sendReminders);
  document.getElementById("create-assignment-btn").addEventListener("click", createAssignmentFromPicker);

  // Typing Test tab
  document.getElementById("test-create-btn").addEventListener("click", createTestAssignmentFromForm);

  document.getElementById("test-csv-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    clearFlash();

    if (!isSignedIn()) {
      flash("Sign in with Google first.");
      e.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        currentTestCsvText = reader.result;
        const classNames = distinctTestClassNames(currentTestCsvText);
        if (classNames.length === 0) {
          flash("No usable rows found in that CSV (need First Name, Last Name, Class, Test, and Date columns).");
          return;
        }
        populateTestClassPicker(classNames);
        showTestStep("class");
      } catch (err) {
        console.error(err);
        flash(`Couldn't read that CSV: ${err.message}`);
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("test-back-to-upload-btn").addEventListener("click", () => {
    currentTestCsvText = null;
    currentTestEntry = null;
    clearFlash();
    showTestStep("upload");
  });

  document.getElementById("test-load-btn").addEventListener("click", loadTestClass);
  document.getElementById("test-submit-btn").addEventListener("click", submitCheckedTestGrades);

  document.getElementById("test-change-class-btn").addEventListener("click", () => {
    currentTestEntry = null;
    clearFlash();
    showTestStep("class");
  });

  document.getElementById("test-grade-another-btn").addEventListener("click", () => {
    currentTestEntry = null;
    clearFlash();
    showTestStep("class");
  });

  document.getElementById("test-grade-another-csv-btn").addEventListener("click", () => {
    currentTestEntry = null;
    currentTestCsvText = null;
    clearFlash();
    showTestStep("upload");
  });

  // Nav tabs: "Create Assignments" and "Typing Test" don't depend on a CSV,
  // so they can be reached directly; "Grade" resumes wherever its
  // multi-step flow was left.
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => {
      clearFlash();
      if (btn.dataset.nav === "create") {
        populateClassCheckboxList("ahead-class-list");
        populateAheadLessonPicker();
        showView("create");
      } else if (btn.dataset.nav === "test") {
        populateClassCheckboxList("test-create-class-list");
        showView("test");
      } else {
        showView(gradeSubView);
      }
    });
  }

  document.getElementById("grade-back-to-upload-btn").addEventListener("click", () => {
    currentCsvText = null;
    currentGradeClass = null;
    currentPlan = [];
    clearFlash();
    showView("grade-upload");
  });

  document.getElementById("change-class-btn").addEventListener("click", () => {
    currentPlan = [];
    clearFlash();
    populateGradeClassPicker(distinctClassNames(currentCsvText));
    showView("grade-class-pick");
  });

  document.getElementById("load-another-btn").addEventListener("click", () => {
    currentPlan = [];
    currentCsvText = null;
    currentGradeClass = null;
    clearFlash();
    showView("grade-upload");
  });

  document.getElementById("grade-another-class-btn").addEventListener("click", () => {
    currentPlan = [];
    clearFlash();
    populateGradeClassPicker(distinctClassNames(currentCsvText));
    showView("grade-class-pick");
  });

  document.getElementById("grade-another-csv-btn").addEventListener("click", () => {
    currentPlan = [];
    currentCsvText = null;
    currentGradeClass = null;
    clearFlash();
    showView("grade-upload");
  });

  showView("grade-upload");
});
