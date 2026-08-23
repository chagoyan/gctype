// Google Identity Services implicit token-client flow.
// Access-token-only, ~1hr, no refresh token (static/client-side app has
// nowhere safe to hold a client secret). Frequent re-login is expected and
// accepted. Do NOT use initCodeClient (needs a backend token exchange).
// Reuses the existing Web-application OAuth client in the
// `classroom-web-sync` Google Cloud project.

// TODO: fill in the real client ID (from the classroom-web-sync OAuth client).
const OAUTH_CLIENT_ID = "TODO.apps.googleusercontent.com";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students",
].join(" ");

let tokenClient = null;
let accessToken = null;

function initAuth(onToken) {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
    callback: (resp) => {
      accessToken = resp.access_token;
      onToken(accessToken);
    },
  });
}

function signIn() {
  tokenClient.requestAccessToken();
}
