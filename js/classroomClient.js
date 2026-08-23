// Port of typing-grader/grader/classroom_client.py.
// Client-side fetch wrapper for the Google Classroom API, using the
// access token from auth.js. Note the hard platform constraint: grades can
// only be patched by the same OAuth client that created the assignment
// (ProjectPermissionDenied otherwise) — this tool must remain the only way
// assignments get created.

const CLASSROOM_API = "https://classroom.googleapis.com/v1";

async function classroomFetch(path, options = {}) {
  if (!isSignedIn()) {
    throw new Error("Not signed in (or token expired) -- call signIn() first.");
  }
  const res = await fetch(`${CLASSROOM_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Classroom API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// TODO: port listCourses, listRoster, createAssignment, patchGrade from
// classroom_client.py.
