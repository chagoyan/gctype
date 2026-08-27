// Entry point / view state management.
// Replaces the Flask routes (/upload, /preview/<id>, /submit/<id>) with
// client-side state transitions -- no server round-trip. See
// typing-grader/app.py's build_plan/upload/preview/submit for the logic
// this ports.

let classroomClient = null; // instantiated once auth is ready
let currentPlan = []; // array of group entries, see buildPlan() below
let currentCsvText = null; // raw CSV text, kept so re-picking a class can rebuild the plan
let currentGradeClass = null; // className the current plan/preview is scoped to

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

// ---------------------------------------------------------------------
// Small view helpers
// ---------------------------------------------------------------------

function showView(name) {
  for (const el of document.querySelectorAll(".view")) {
    el.hidden = el.id !== `view-${name}`;
  }
  if (GRADE_VIEWS.has(name)) gradeSubView = name;
  const activeTab = GRADE_VIEWS.has(name) ? "grade" : "create";
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
  const rows = parseTypingCsv(csvText).map((row) => ({
    ...row,
    lesson: canonicalizeLesson(row.lesson),
  }));
  const groups = groupByClassAndLesson(rows);

  const sortedGroups = [...groups.values()]
    .filter((g) => g.className === selectedClassName)
    .sort((a, b) => {
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

    const course = await classroomClient.findCourseByName(group.className);
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

    const roster = await classroomClient.getRoster(course.id);
    const submissions = await classroomClient.getSubmissions(course.id, coursework.id);
    const subsByUser = new Map(submissions.map((s) => [s.userId, s]));
    const maxPoints = coursework.maxPoints || 0;

    for (const row of group.rows) {
      const { student, status } = matchStudent(row.firstName, row.lastName, roster);
      const studentEntry = {
        firstName: row.firstName,
        lastName: row.lastName,
        progressPct: row.progressPct,
        status,
        grade: null,
        submissionId: null,
        turnedIn: null,
      };
      if (status === "matched") {
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
            studentEntry.grade = computeGrade(row.progressPct, maxPoints, turnedIn);
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

// ---------------------------------------------------------------------
// Preview rendering (typing-grader/templates/preview.html)
// ---------------------------------------------------------------------

const STATUS_LABELS = {
  matched: "Matched",
  no_submission: "Matched, but no submission record found — needs manual grading",
  ambiguous: "Ambiguous name match on roster — needs manual grading",
  not_found: "Not found on roster — needs manual grading",
  not_yet_due: "Not yet due — waiting to grade incomplete/not-turned-in work",
};

// ---------------------------------------------------------------------
// "Create Assignments" picker (typing-grader/preview.html's ahead-of-time
// assignment form + typing-grader/app.py's create_assignment route)
// ---------------------------------------------------------------------

/**
 * Which classes were checked before this (re)population, so a rebuild
 * (e.g. after creating an assignment re-matches the CSV) doesn't lose the
 * teacher's selection -- same "sticky" intent as the old single-select's
 * `previous` handling.
 */
function checkedAheadClasses() {
  return Array.from(document.querySelectorAll('#ahead-class-list input[type="checkbox"]:checked')).map(
    (cb) => cb.value
  );
}

async function populateAheadClassPicker() {
  const list = document.getElementById("ahead-class-list");
  const previouslyChecked = new Set(checkedAheadClasses());
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
  const classNames = checkedAheadClasses();
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

        const tdName = document.createElement("td");
        tdName.textContent = `${s.firstName} ${s.lastName}`;
        tr.appendChild(tdName);

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
  showView("grade-preview");
}

// ---------------------------------------------------------------------
// Unit / Lesson filters (ported from preview.html's inline script; the
// class dimension moved to a fetch-time picker, see loadGradeClass)
// ---------------------------------------------------------------------

function setupFilters() {
  const unitSelect = document.getElementById("filter-unit");
  const lessonSelect = document.getElementById("filter-lesson");
  const sections = Array.from(document.querySelectorAll("#groups-container .group"));

  function uniqueValues(attr, matches) {
    const seen = new Set();
    const values = [];
    for (const s of sections) {
      const v = s.dataset[attr];
      if (matches(s) && !seen.has(v)) {
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
      const match = (unit === "" || s.dataset.unit === unit) && (lesson === "" || s.dataset.lesson === lesson);
      s.style.display = match ? "" : "none";
    }
  }

  fillSelect(unitSelect, uniqueValues("unit", () => true), "All units");
  unitSelect.value = "";

  unitSelect.onchange = () => {
    populateLessons();
    applyFilter();
  };
  lessonSelect.onchange = applyFilter;

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
  document.getElementById("create-assignment-btn").addEventListener("click", createAssignmentFromPicker);

  // Nav tabs: "Create Assignments" doesn't depend on a CSV, so it can be
  // reached directly; "Grade" resumes wherever the multi-step flow was left.
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => {
      clearFlash();
      if (btn.dataset.nav === "create") {
        populateAheadClassPicker();
        populateAheadLessonPicker();
        showView("create");
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

  document.getElementById("grade-another-btn").addEventListener("click", () => {
    currentPlan = [];
    currentCsvText = null;
    currentGradeClass = null;
    clearFlash();
    showView("grade-upload");
  });

  showView("grade-upload");
});
