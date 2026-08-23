// Port of typing-grader/grader/csv_parser.py.
// Parses the Typing.com CSV export in-browser. Raw CSV never leaves the
// client — this is the core of the FERPA fix for the online migration.
// See: typing-autograder-online-migration-handoff.md

// TODO: port parsing logic from csv_parser.py.
// Expected shape per row (confirm against real CSV columns):
//   { class: string, lesson: string, firstName: string, lastName: string,
//     progress: number, turnedIn: boolean }

function parseTypingCsv(fileText) {
  throw new Error("not yet implemented");
}
