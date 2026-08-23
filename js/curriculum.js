// Port of the CURRICULUM dict and related ordering helpers from
// typing-grader/app.py (lines ~59-241). Typing.com has no API for its own
// curriculum, so this is a hand-transcribed snapshot -- must be kept in
// sync by hand if Typing.com adds, renames, or reorders lessons.
//
// Used only for the "Create an assignment ahead of time" picker (task #9)
// so a class's assignment can be set up before any CSV mentions the
// lesson. Grading (matcher.js) never touches this -- it only ever looks at
// what's actually in the uploaded CSV.

const CURRICULUM = {
  "Learn the Keys 1": [
    "J, F, and Space",
    "U, R, and K Keys",
    "D, E, and I Keys",
    "C, G, and N Keys",
    "Beginner Review 1",
    "T, S, and L Keys",
    "O, B, and A Keys",
    "V, H, and M Keys",
    "Period and Comma",
    "Beginner Review 2",
    "W, X, and ; Keys",
    "Q, Y, and P Keys",
    "Z and Enter Keys",
    "Beginner Wrap-up",
    "Personalized Practice",
    "Assessment 1",
  ],
  "Learn the Keys 2": [
    "Shift Key and Capitalization",
    "Basic Punctuation",
    "Intermediate Punctuation",
    "Numbers Letters Numbers",
    "Advanced Symbols",
    "Paragraph Practice",
    "Test-Prep Vocabulary",
    "Informational Texts",
    "Script Writing",
    "MLA Citations",
    "Final Review",
    "Personalized Practice",
    "Assessment 2",
  ],
  "Cross Curricular 1": [
    "The Constitution: Structure and Principles",
    "How a Law Is Made",
    "The Electoral Process and Civic Participation",
    "Economics: Markets and Policy",
    "Fiscal and Monetary Policy",
    "Geopolitics: International Organizations and Trade",
    "Strategic Geography and Global Resources",
    "First Aid, CPR, and Emergency Response",
    "Mental Health and Relationships",
    "Contemporary and Global Art Traditions",
    "20th Century Music Genres",
    "Spanish Workplace Vocabulary",
    "Spanish Travel and Cultural Traditions",
    "French Travel and Dining",
    "Taxes, Filing, W-2s, and the 1040 Form",
    "Credit, Debt Management, and Investing",
    "Insurance, Leases, and SMART Goals",
    "College Planning, FAFSA, and Career Readiness",
  ],
  "Cross Curricular 2": [
    "Star Life Cycles",
    "Structure of the Universe",
    "Plate Tectonics and Earth's Interior",
    "The Rock Cycle and Earth's Resources",
    "Natural Resources and Sustainability",
    "Standard Deviation and Data Spread",
    "Normal Distribution and Probability",
    "Correlation, Causation, and Statistical Reasoning",
    "Conditional Probability and Decision Making",
    "Limits and Advanced Functions",
    "HTML - The Structure of a Webpage",
    "CSS - Making the Web Beautiful",
    "JavaScript - Programming the Web",
  ],
  "Creative Writing": [
    "College Application Prep",
    "Job Application Prep",
    "Just for Fun",
    "When Robots Rule the World",
    "Spellbound",
    "Clandestine",
    "The Game",
    "Personalized Practice",
  ],
};

// Unit display order, transcribed from the same Curriculum page. Only the
// units in CURRICULUM above have known lessons; the rest are included so
// ordering stays correct if they're ever assigned too. Units not in this
// list (a rename, a new unit added on Typing.com's end, etc.) sort after
// all of these, alphabetically among themselves, rather than breaking.
const UNIT_ORDER = [
  "Learn the Keys 1",
  "Learn the Keys 2",
  "Cross Curricular 1",
  "Cross Curricular 2",
  "Creative Writing",
  "Technology Foundations",
  "Digital Citizenship",
  "AI Literacy",
  "Word Processing",
  "Spreadsheets",
  "Presentations",
  "Custom Lessons",
  "Problem Keys",
];

/**
 * Typing.com lesson titles are "<Unit>: <N>. <Title>", e.g.
 * "Learn the Keys 1: 1. J, F, and Space" -> unit "Learn the Keys 1".
 * Falls back to the whole lesson string if it doesn't have that shape
 * (there's no separate "Unit" column in the CSV -- "Curriculum" is just
 * the grade level, e.g. "12th Grade").
 */
function unitName(lesson) {
  const idx = lesson.indexOf(": ");
  return idx === -1 ? lesson : lesson.slice(0, idx).trim();
}

/**
 * Split text into alternating text/number chunks so numbers sort
 * numerically -- e.g. "...: 2. U, R, and K Keys" before
 * "...: 10. Period and Comma" -- instead of lexically (where "10" < "2").
 * Also used for class names so periods sort P1, P2, ..., P10 instead of
 * P1, P10, P2, ....
 *
 * Returns an array of strings/numbers suitable for comparing with
 * compareNaturalKeys below (JS has no native tuple/array comparison like
 * Python's list comparison).
 */
function naturalSortKey(s) {
  return s
    .split(/(\d+)/)
    .filter((tok) => tok !== "")
    .map((tok) => (/^\d+$/.test(tok) ? parseInt(tok, 10) : tok.toLowerCase()));
}

/** Compare two naturalSortKey() results element-by-element. */
function compareNaturalKeys(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === typeof y) {
      if (x < y) return -1;
      if (x > y) return 1;
    } else {
      // number vs string chunk at the same position: treat number as smaller,
      // consistent with Python only ever comparing same-typed elements in
      // practice (mixed comparisons here are effectively unreachable given
      // how the strings being compared are structured the same way).
      return typeof x === "number" ? -1 : 1;
    }
  }
  return 0;
}

function naturalSort(strings) {
  return [...strings].sort((a, b) => compareNaturalKeys(naturalSortKey(a), naturalSortKey(b)));
}

/**
 * Sort class names by the period number embedded in them (e.g. "P2" in
 * "WAD-P2-S1-2627"), not by the class name's own text.
 *
 * naturalSortKey alone isn't enough here: it would sort "WAD-P2-..."
 * before "WPD-P1-..." because it compares the "WAD"/"WPD" prefix first,
 * grouping all periods of one prep before any period of another instead
 * of interleaving them by period. Classes without a recognizable
 * "P<number>" sort after all that have one, then alphabetically among
 * themselves.
 */
function periodSortKey(className) {
  const match = className.match(/[Pp](\d+)/);
  const period = match ? parseInt(match[1], 10) : Infinity;
  return { period, rest: naturalSortKey(className) };
}

function comparePeriodKeys(a, b) {
  if (a.period !== b.period) return a.period - b.period;
  return compareNaturalKeys(a.rest, b.rest);
}

/**
 * Order units the way Typing.com's Curriculum page presents them (see
 * UNIT_ORDER) instead of alphabetically -- e.g. "Learn the Keys 1" before
 * "Cross Curricular 1" even though "C" < "L". Units not in UNIT_ORDER sort
 * after all known ones, alphabetically among themselves.
 */
function unitSortKey(unit) {
  const index = UNIT_ORDER.indexOf(unit);
  return { index: index === -1 ? UNIT_ORDER.length : index, name: unit.toLowerCase() };
}

function compareUnitKeys(a, b) {
  if (a.index !== b.index) return a.index - b.index;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/**
 * (unit, [full lesson title, ...]) pairs, in curriculum order, for the
 * "Create an assignment ahead of time" dropdown.
 *
 * Built from CURRICULUM (independent of any CSV) plus, as a safety net,
 * any lesson actually seen in the current plan that CURRICULUM doesn't
 * already cover -- e.g. a transcription gap, or a unit added on
 * Typing.com's end since this was last updated. Grading never touches
 * CURRICULUM; this is purely for offering lessons to create an assignment
 * for before any CSV mentions them.
 *
 * @param {Array<{unit: string, lesson: string}>} plan - entries from the
 *   current grading plan (each with at least `unit` and `lesson`); pass []
 *   if there's no plan loaded yet.
 * @returns {Array<[string, string[]]>}
 */
function curriculumLessonGroups(plan) {
  const groups = new Map();
  for (const [unit, titles] of Object.entries(CURRICULUM)) {
    groups.set(
      unit,
      titles.map((title, i) => `${unit}: ${i + 1}. ${title}`)
    );
  }

  const known = new Set();
  for (const lessons of groups.values()) {
    for (const lesson of lessons) known.add(lesson);
  }

  for (const entry of plan) {
    if (!known.has(entry.lesson)) {
      if (!groups.has(entry.unit)) groups.set(entry.unit, []);
      groups.get(entry.unit).push(entry.lesson);
      known.add(entry.lesson);
    }
  }

  for (const [unit, lessons] of groups) {
    groups.set(unit, naturalSort(lessons));
  }

  return [...groups.keys()]
    .sort((a, b) => compareUnitKeys(unitSortKey(a), unitSortKey(b)))
    .map((unit) => [unit, groups.get(unit)]);
}

// Node-only export for the standalone unit tests in test/. Harmless no-op
// in the browser (module is undefined there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CURRICULUM,
    UNIT_ORDER,
    unitName,
    naturalSortKey,
    compareNaturalKeys,
    naturalSort,
    periodSortKey,
    comparePeriodKeys,
    unitSortKey,
    compareUnitKeys,
    curriculumLessonGroups,
  };
}
