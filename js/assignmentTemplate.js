// Port of assignment_description_template.txt + build_assignment_description()
// from typing-grader/app.py. Ported to a JS template string per the
// migration porting map (was a separately-editable file in the Flask
// version so it could be changed without touching code; here it's just a
// constant -- editing it means a redeploy, same as any other UI text).
//
// Inserted into Classroom as plain text -- Classroom doesn't render
// Markdown, so "*" bullets show up as literal asterisks, matching how the
// original template looks in Classroom today.
const ASSIGNMENT_DESCRIPTION_TEMPLATE = `{lesson}

You have several lessons for this unit of Typing.com

Complete:

* {lesson}

Submit 1 Item:

* A GoFullPage screenshot of your Typing.com lessons.
* Make sure the screenshot shows the correct unit, all relevant lessons, and your name at the top of the webpage.

You must complete the lesson and submit it to earn full points.  Submitted assignments without screenshots will not earn full points.

Direct Link to Typing.com:
https://www.typing.com/`;

/**
 * Description for an assignment the tool creates itself, with the lesson
 * name filled in. Due date is intentionally left for the teacher to set by
 * hand for now (matches the Flask version).
 */
function buildAssignmentDescription(lesson) {
  // replaceAll, not replace -- the template above has two "{lesson}"
  // placeholders and Python's str.replace() replaces every occurrence by
  // default (JS's non-global .replace() only replaces the first).
  return ASSIGNMENT_DESCRIPTION_TEMPLATE.replaceAll("{lesson}", lesson);
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { ASSIGNMENT_DESCRIPTION_TEMPLATE, buildAssignmentDescription };
}
