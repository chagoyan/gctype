// Port of typing-grader/grader/classroom_client.py.
// Client-side fetch wrapper for the Google Classroom API, using the
// access token from auth.js. Note the hard platform constraint: grades can
// only be patched by the same OAuth client that created the assignment
// (ProjectPermissionDenied otherwise) -- this tool must remain the only way
// assignments get created.

const CLASSROOM_API = "https://classroom.googleapis.com/v1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Statuses worth retrying: 429 (rate limit) and Google's own transient
// server-side errors. A bare 500 "Internal error encountered." with no
// further detail (seen 2026-09-09 creating back-to-back coursework across
// classes) is Google's generic server hiccup, not a real conflict --
// those come back with their own distinct messages -- so a short backoff
// and retry clears it without surfacing anything to the user.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [600, 1500];

async function classroomFetch(path, options = {}) {
  if (!isSignedIn()) {
    throw new Error("Not signed in (or token expired) -- call signIn() first.");
  }
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(`${CLASSROOM_API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (res.ok) return res.json();

    const bodyText = await res.text();
    lastErr = new Error(`Classroom API error ${res.status}: ${bodyText}`);
    const canRetry = RETRYABLE_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length;
    if (!canRetry) throw lastErr;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastErr;
}

/**
 * Loop through every page of a Classroom "list" endpoint, accumulating
 * `itemsKey` from each page's response into a single array.
 *
 * @param {string} path - endpoint path, e.g. "/courses"
 * @param {Object} params - query params (values may be arrays, sent as
 *   repeated params -- e.g. { courseStates: ["ACTIVE"] })
 * @param {string} itemsKey - key in each page's response holding the array
 */
async function listAllPages(path, params, itemsKey) {
  const items = [];
  let pageToken;
  do {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        for (const v of value) qs.append(key, v);
      } else if (value !== undefined && value !== null) {
        qs.append(key, value);
      }
    }
    if (pageToken) qs.append("pageToken", pageToken);

    const resp = await classroomFetch(`${path}?${qs.toString()}`);
    items.push(...(resp[itemsKey] || []));
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return items;
}

class ClassroomClient {
  constructor() {
    this._coursesCache = null;
    this._courseworkCache = new Map(); // courseId -> courseWork[]
  }

  async listActiveCourses() {
    if (this._coursesCache !== null) return this._coursesCache;
    const courses = await listAllPages(
      "/courses",
      { teacherId: "me", courseStates: ["ACTIVE"] },
      "courses"
    );
    this._coursesCache = courses;
    return courses;
  }

  /**
   * Exact string match on the Classroom course `name` field.
   * Relies on courses being named to match the CSV `Class` column exactly,
   * including the school-year suffix (e.g. WAD-P2-S1-2627).
   */
  async findCourseByName(className) {
    const target = className.trim();
    const courses = await this.listActiveCourses();
    return courses.find((c) => (c.name || "").trim() === target) || null;
  }

  /**
   * All coursework in a course, cached per courseId -- with the cross
   * product build_plan does (every class x every lesson any class has
   * reached), findCourseworkByTitle is called far more often than a naive
   * implementation would suggest, so each course's assignment list is only
   * paginated through once per run.
   */
  async listCoursework(courseId) {
    if (this._courseworkCache.has(courseId)) return this._courseworkCache.get(courseId);
    const items = await listAllPages(`/courses/${courseId}/courseWork`, {}, "courseWork");
    this._courseworkCache.set(courseId, items);
    return items;
  }

  /** Exact string match on assignment title within one course. */
  async findCourseworkByTitle(courseId, title) {
    const target = title.trim();
    const coursework = await this.listCoursework(courseId);
    return coursework.find((cw) => (cw.title || "").trim() === target) || null;
  }

  async getRoster(courseId) {
    const students = await listAllPages(`/courses/${courseId}/students`, {}, "students");
    return students.map((s) => {
      const name = (s.profile && s.profile.name) || {};
      return {
        userId: s.userId,
        givenName: name.givenName || "",
        familyName: name.familyName || "",
        fullName: name.fullName || "",
        // Only populated with the classroom.profile.emails scope granted
        // (see auth.js) -- empty string otherwise. Used by the "remind
        // students who forgot to turn in" feature to address the email.
        email: (s.profile && s.profile.emailAddress) || "",
      };
    });
  }

  async getSubmissions(courseId, courseworkId) {
    return listAllPages(
      `/courses/${courseId}/courseWork/${courseworkId}/studentSubmissions`,
      {},
      "studentSubmissions"
    );
  }

  /**
   * Set assignedGrade (and draftGrade) on a student's submission.
   * Verified live (2026-08-22): does NOT require the submission to be
   * turned in first -- see project memory project_typing_auto_grader_tool.
   */
  async patchGrade(courseId, courseworkId, submissionId, grade) {
    const body = { assignedGrade: grade, draftGrade: grade };
    return classroomFetch(
      `/courses/${courseId}/courseWork/${courseworkId}/studentSubmissions/${submissionId}?updateMask=assignedGrade,draftGrade`,
      { method: "PATCH", body: JSON.stringify(body) }
    );
  }

  /**
   * Classroom's "Return" button: hands the graded submission back so the
   * student sees their grade. Same coursework.students scope as patchGrade.
   * Callers only return TURNED_IN work -- see app.js's gradeAndMaybeReturn.
   */
  async returnSubmission(courseId, courseworkId, submissionId) {
    return classroomFetch(
      `/courses/${courseId}/courseWork/${courseworkId}/studentSubmissions/${submissionId}:return`,
      { method: "POST", body: "{}" }
    );
  }

  async turnIn(courseId, courseworkId, submissionId) {
    return classroomFetch(
      `/courses/${courseId}/courseWork/${courseworkId}/studentSubmissions/${submissionId}:turnIn`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  /**
   * Create a new assignment in the given course, PUBLISHED by default or
   * DRAFT if `asDraft` is set (shows as a draft in Classroom, same as one
   * started by hand and not posted -- the teacher posts it later from
   * Classroom's own UI).
   *
   * Because this app's own OAuth client creates the coursework, it (unlike
   * coursework created by hand in the Classroom UI) can later be graded
   * via patchGrade -- see the ProjectPermissionDenied constraint noted
   * throughout this project's memory. Used when a CSV references a lesson
   * with no matching assignment yet.
   *
   * `dueDate`, if given, is a JS Date. Classroom's API rejects dueDate
   * without dueTime ("Due date and time must be set or cleared together"),
   * so a fixed 11:59 PM dueTime is always sent alongside it -- Classroom's
   * own UI then shows just the date, matching manually-created assignments.
   */
  async createCoursework(courseId, { title, description, maxPoints, topicId, dueDate, asDraft }) {
    const body = {
      title,
      description,
      workType: "ASSIGNMENT",
      maxPoints,
      state: asDraft ? "DRAFT" : "PUBLISHED",
    };
    if (dueDate) {
      body.dueDate = {
        year: dueDate.getFullYear(),
        month: dueDate.getMonth() + 1,
        day: dueDate.getDate(),
      };
      body.dueTime = { hours: 23, minutes: 59 };
    }
    if (topicId) body.topicId = topicId;

    const created = await classroomFetch(`/courses/${courseId}/courseWork`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // New coursework invalidates this course's cached list.
    this._courseworkCache.delete(courseId);
    return created;
  }

  /** Exact string match on topic name within one course. */
  async findTopicByName(courseId, name) {
    const target = name.trim();
    const topics = await listAllPages(`/courses/${courseId}/topics`, {}, "topic");
    return topics.find((t) => (t.name || "").trim() === target) || null;
  }

  /**
   * Find a topic by exact name in the course, creating it if missing.
   * Used to file tool-created assignments under a fixed "Pending" topic so
   * they're easy to find and re-title/re-file later.
   */
  async getOrCreateTopic(courseId, name) {
    const existing = await this.findTopicByName(courseId, name);
    if (existing) return existing;
    return classroomFetch(`/courses/${courseId}/topics`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }
}
