// Google Identity Services implicit token-client flow.
// Access-token-only, ~1hr, no refresh token (a static/client-side app has
// nowhere safe to hold a client secret). Frequent re-login is expected and
// accepted -- see project memory project_typing_auto_grader_tool. Do NOT
// switch to initCodeClient: that needs a backend token exchange, which is
// explicitly out of scope for this app.
//
// Reuses the existing Web-application OAuth client ("gcdash") in the
// classroom-web-sync Google Cloud project -- this app's own Netlify URL
// (https://gctype.netlify.app) is registered on that client's Authorized
// JavaScript origins. This ID is public (it's sent to Google from the
// browser on every request); it is not a secret.
const OAUTH_CLIENT_ID =
  "8527216010-4k8cqguj42qjfa812a6m1b278ia5f7sj.apps.googleusercontent.com";

// Matches SCOPES in typing-grader/grader/classroom_client.py exactly,
// including classroom.topics -- needed for get_or_create_topic /
// find_topic_by_name (the "Pending" topic assignments get filed under).
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students",
  "https://www.googleapis.com/auth/classroom.topics",
].join(" ");

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = null; // ms since epoch

/**
 * Set up the token client. `onToken(token)` fires on every successful grant
 * (explicit sign-in click, or a silent re-auth that succeeds). `onError(err)`
 * fires if a requested grant fails or is denied.
 */
function initAuth(onToken, onError) {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPES,
    callback: (resp) => {
      if (resp.error) {
        accessToken = null;
        tokenExpiresAt = null;
        if (onError) onError(resp);
        return;
      }
      accessToken = resp.access_token;
      // expires_in is seconds; back off 60s as a safety margin.
      tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
      onToken(accessToken);
    },
    error_callback: (err) => {
      if (onError) onError(err);
    },
  });

  // Try a silent grant first (no popup) in case the user still has an
  // active Google session and has already consented -- saves a click on
  // same-day revisits. Safe to ignore failures here: signIn() below always
  // falls back to an explicit, user-visible prompt.
  tokenClient.requestAccessToken({ prompt: "" });
}

/** Explicit sign-in, triggered by a user gesture (a button click). */
function signIn() {
  tokenClient.requestAccessToken({ prompt: "consent" });
}

function isSignedIn() {
  return Boolean(accessToken) && Boolean(tokenExpiresAt) && Date.now() < tokenExpiresAt;
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = null;
}

function getAccessToken() {
  return accessToken;
}
