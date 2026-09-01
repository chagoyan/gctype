// Minimal client-side wrapper around the Gmail API's messages.send, used
// only to send the "you finished but forgot to turn in" reminder emails
// (see app.js's reminder section). Send-only -- nothing here ever reads a
// mailbox. Requires the gmail.send scope (see auth.js).

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

async function gmailFetch(path, options = {}) {
  if (!isSignedIn()) {
    throw new Error("Not signed in (or token expired) -- call signIn() first.");
  }
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Base64url-encode a JS string as UTF-8 bytes -- the encoding Gmail's
 * `raw` field requires for the full RFC 2822 message. Plain `btoa` alone
 * only handles Latin-1, so the string is run through TextEncoder first.
 */
function base64UrlEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * MIME "encoded-word" form (RFC 2047) for a header value that may contain
 * non-ASCII characters (e.g. a lesson title with an accent) -- headers
 * themselves should stay ASCII even though the body is sent as UTF-8.
 */
function encodeHeaderValue(value) {
  const b64 = btoa(unescape(encodeURIComponent(value)));
  return `=?UTF-8?B?${b64}?=`;
}

/** Build a minimal plain-text RFC 2822 message. */
function buildRfc2822Message({ to, from, subject, body }) {
  const headers = [
    `To: ${to}`,
    ...(from ? [`From: ${from}`] : []),
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/**
 * Send a plain-text email as the signed-in user. `from` is optional --
 * omitting it lets Gmail fill in the authenticated account's own address,
 * which is what we want (Manuel's address, not a spoofed one).
 */
async function sendEmail(to, subject, body) {
  const raw = base64UrlEncodeUtf8(buildRfc2822Message({ to, subject, body }));
  return gmailFetch("/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
}
