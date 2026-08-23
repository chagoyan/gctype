// Entry point / view state management.
// Replaces the Flask routes (/upload, /preview/<id>, /submit/<id>) with
// client-side state transitions -- no server round-trip.

document.addEventListener("DOMContentLoaded", () => {
  const authStatus = document.getElementById("auth-status");
  const signinBtn = document.getElementById("signin-btn");

  function renderSignedIn() {
    authStatus.textContent = "Signed in";
    signinBtn.textContent = "Re-authenticate";
  }

  function renderSignedOut() {
    authStatus.textContent = "";
    signinBtn.textContent = "Sign in with Google";
  }

  initAuth(
    (token) => renderSignedIn(),
    (err) => {
      // The very first call on page load is a silent attempt (prompt: "")
      // that's expected to "fail" for most visits (no active Google
      // session, or consent not yet granted) -- that's normal, not an
      // error worth surfacing. Only the explicit sign-in click should ever
      // show something to the user, and even then only if it's not just
      // the user closing the popup.
      renderSignedOut();
      if (err && err.type && err.type !== "popup_closed") {
        console.warn("Google auth error:", err);
      }
    }
  );

  signinBtn.addEventListener("click", signIn);

  document.getElementById("csv-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseTypingCsv(reader.result);
      const groups = groupByClassAndLesson(rows);
      // TODO: for each group, look up the matching Classroom course +
      // assignment via classroomClient.js, match students via matcher.js,
      // then render the preview view (task #8).
      console.log(`Parsed ${rows.length} rows into ${groups.size} class+lesson groups.`);
    };
    reader.readAsText(file);
  });
});
