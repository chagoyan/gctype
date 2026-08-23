// Entry point / view state management.
// Replaces the Flask routes (/upload, /preview/<id>, /submit/<id>) with
// client-side state transitions — no server round-trip.

document.addEventListener("DOMContentLoaded", () => {
  const authStatus = document.getElementById("auth-status");

  initAuth((token) => {
    authStatus.textContent = "Signed in";
  });

  document.getElementById("signin-btn").addEventListener("click", signIn);

  document.getElementById("csv-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // TODO: parseTypingCsv(reader.result), then matcher, then render preview
      console.log("CSV loaded, length:", reader.result.length);
    };
    reader.readAsText(file);
  });
});
