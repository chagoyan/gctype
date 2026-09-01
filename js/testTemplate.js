// Title/description builders for typing-test checkpoint assignments (see
// the "Typing Test" tab in app.js). Unlike lesson assignments (one fixed
// title per lesson, from CURRICULUM), a teacher can create as many of
// these as they want -- one per checkpoint during the year (August
// diagnostic, end of Q1, a retake, etc.) -- distinguished only by a number
// they supply themselves. Settled with Manuel 2026-08-31: title is
// "Typing Test Results {number}", not tied to a specific date range in its
// name, so he's free to number them however he likes.

/** "Typing Test Results {number}" -- trims the number so stray whitespace from the input field doesn't produce e.g. "Typing Test Results 1 " with a trailing space that would break exact-title matching later. */
function buildTestAssignmentTitle(number) {
  return `Typing Test Results ${String(number).trim()}`;
}

const TEST_ASSIGNMENT_DESCRIPTION_TEMPLATE = `{title}

Complete a 3 Minute Typing Test on Typing.com.

Submit 1 Item:

* A GoFullPage screenshot of your 3 Minute Typing Test result.
* Make sure the screenshot shows your name, the test type (3 Minute Typing Test), and the date at the top of the webpage.

You must complete the test and submit it to earn full points. Submitted assignments without screenshots will not earn full points.

Direct Link to Typing.com:
https://www.typing.com/`;

/** Description for a typing-test assignment the tool creates itself, with the title filled in. */
function buildTestAssignmentDescription(number) {
  return TEST_ASSIGNMENT_DESCRIPTION_TEMPLATE.replaceAll("{title}", buildTestAssignmentTitle(number));
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TEST_ASSIGNMENT_DESCRIPTION_TEMPLATE,
    buildTestAssignmentTitle,
    buildTestAssignmentDescription,
  };
}
