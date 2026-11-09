// The wire-format tests that don't need a bridge: fences, the prose filter,
// and the preamble's honesty about what a helper actually does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, prose, preamble, attemptedMarker, MARKER_LINE, MARKERS } from '../harness/protocol.mjs';
import { KNOWN_MARKERS } from '../harness/meta/verify.mjs';

test('MARKERS is the parser list, keyword for keyword', () => {
  // MARKER_LINE has a per-marker shape (NEED takes an argument, RUN takes
  // `bg`) that cannot be generated from the list, so the two are held equal
  // by extraction — the same read ui.test.mjs uses for the window's mirror:
  // every capital keyword in the regex source, sorted.
  const fromLine = [...new Set([...MARKER_LINE.source.matchAll(/\b([A-Z]{2,})\b/g)].map((m) => m[1]))].sort();
  assert.deepEqual([...MARKERS].sort(), fromLine, 'the one list is every keyword MARKER_LINE knows');
  assert.equal(MARKERS.length, 33, 'and it is the whole protocol, not a subset');
  for (const m of ['TREE', 'STAT', 'RETRIEVE', 'DIAGNOSE', 'GOAL']) {
    assert.ok(MARKERS.includes(m), `${m} is in the list — the verifier copy used to lose it`);
  }
  assert.deepEqual([...KNOWN_MARKERS].sort(), [...MARKERS].sort(), 'the meta verifier knows the same list, not a copy');
});

test('markers inside a fenced block are a quotation, not a request', () => {
  const reply = [
    'Here is the shape:',
    '```',
    'NEED file src/index.ts',
    'EDIT a.txt',
    'FIND',
    'hello',
    'NEW',
    'goodbye',
    'END',
    '```',
    'Now for real.',
    'NEED file README.md',
    'DONE quoting, not asking',
  ].join('\n');
  const calls = parse(reply);
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'done']);
  assert.equal(calls[0].arg, 'README.md');
});

test('a DONE inside a fence cannot end the run', () => {
  const calls = parse('```\nDONE all finished\n```\nNEED file a.txt');
  assert.deepEqual(calls.map((c) => c.kind), ['read']);
});

test('an unterminated fence swallows everything after it', () => {
  const calls = parse('```\nNEED file a.txt\nNEED file b.txt');
  assert.deepEqual(calls, []);
});

test('a fence inside a CREATE body is content, and the END still closes it', () => {
  const calls = parse('CREATE doc.md\n# title\n```\nan example\n```\nEND\nDONE wrote');
  assert.equal(calls[0].kind, 'write');
  assert.equal(calls[0].body, '# title\n```\nan example\n```');
  assert.deepEqual(calls.slice(1).map((c) => c.kind), ['done']);
});

test('prose keeps fenced lines and strips only real markers', () => {
  const p = prose('thinking out loud\n```\nNEED file x\n```\nDONE fin');
  assert.match(p, /thinking out loud/);
  assert.match(p, /NEED file x/, 'a quoted marker is literal content');
  assert.doesNotMatch(p, /DONE fin/);
});

test('a bare NEED is the file form — the shape weak models reach for', () => {
  const calls = parse('NEED events.mjs\nNEED desktop/\nNEED src/app.js 10-20\nDONE read them');
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['read', 'events.mjs'],
    ['read', 'desktop/'],
    ['read', 'src/app.js 10-20'],
    ['done', 'read them'],
  ]);
});

test('English prose that starts with NEED stays prose', () => {
  const reply = 'NEED to see the logs before deciding.\nDONE decided';
  assert.deepEqual(parse(reply).map((c) => c.kind), ['done'], 'a sentence is not a call');
  assert.match(prose(reply), /NEED to see the logs/, 'and it survives the prose filter');
});

test('NEED list and NEED ls are the dir call — the spellings weak models write', () => {
  // Recorded live: `NEED list desktop` came back as a marker that parsed to
  // nothing, so the run sat on a request the harness never saw.
  const calls = parse('NEED list desktop\nNEED ls src\nNEED file a.txt\nDONE looked');
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['list', 'desktop'],
    ['list', 'src'],
    ['read', 'a.txt'],
    ['done', 'looked'],
  ]);
  assert.ok(MARKER_LINE.test('NEED list desktop'), 'and it counts as a marker line, not prose');
  assert.ok(MARKER_LINE.test('NEED ls src'));
});

test('a bare NEED list or NEED dir means the project root', () => {
  const calls = parse('NEED list\nNEED dir\nNEED ls\nDONE saw it');
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['list', '.'], ['list', '.'], ['list', '.'],
    ['done', 'saw it'],
  ]);
  // `NEED file` with no path is not the listing form — it stays the bare
  // single-token read, so a file literally named "file" is still readable.
  assert.deepEqual(parse('NEED file').map((c) => [c.kind, c.arg]), [['read', 'file']]);
});

test('attemptedMarker sees a broken marker line, but not prose or fences', () => {
  assert.equal(attemptedMarker('NEED\n'), true, 'a keyword with nothing after it is an attempt');
  assert.equal(attemptedMarker('Alright.\n**CREATE** the file next\n'), true, 'bolded keywords count');
  assert.equal(attemptedMarker('Need to check the logs first.'), false, 'sentence case is prose');
  assert.equal(attemptedMarker('```\nNEED file x\n```'), false, 'a quoted marker is a quotation');
  assert.equal(attemptedMarker('The capital of France is Paris.'), false, 'an answer is not an attempt');
});

test('a bare NEED is stripped from prose like any marker', () => {
  assert.equal(prose('Let me look.\nNEED events.mjs\nAnything else?'), 'Let me look.\nAnything else?');
});

test('the preamble does not promise parallel helpers', () => {
  const text = preamble({ subagent: true });
  assert.match(text, /runs to completion/);
  assert.doesNotMatch(text, /keep going yourself while it runs/);
});

test('the preamble documents the helper roles', () => {
  const text = preamble({ subagent: true });
  assert.match(text, /role: verifier/);
  assert.match(text, /role: reviewer/);
  assert.match(text, /role: summariser/);
});

test('ASK parses as its own call, and the question is required', () => {
  const reply = 'One thing is genuinely yours to decide.\nASK should the export keep the old column names?\nDONE asked';
  const calls = parse(reply);
  assert.deepEqual(calls.map((c) => c.kind), ['ask', 'done']);
  assert.equal(calls[0].arg, 'should the export keep the old column names?');
  assert.doesNotMatch(prose(reply), /should the export/, 'the question is not repeated as prose');
  assert.deepEqual(parse('ASK\nDONE only done').map((c) => c.kind), ['done'], 'a bare ASK is not a call');
});

test('the preamble documents the ASK pause', () => {
  const text = preamble({});
  assert.match(text, /ASK should the export keep the old column names\?/);
  assert.match(text, /Never put ASK in the same reply as a NEED/);
});

test('the code-navigation markers and JOBS are calls, not prose', () => {
  // They were in the preamble and in MARKER_LINE the whole time, so a reply
  // that used one lost that line from the prose — and then nothing ran it.
  // The line vanished: no call, and a nudge about a marker the model had
  // spelled exactly right.
  const reply = 'SYMBOLS src/index.ts\nDEF someName\nREFS someName\nJOBS\nDONE looked';
  const calls = parse(reply);
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['symbols', 'src/index.ts'],
    ['def', 'someName'],
    ['refs', 'someName'],
    ['jobs', ''],
    ['done', 'looked'],
  ]);
  assert.doesNotMatch(prose(reply), /SYMBOLS|DEF|REFS|JOBS/, 'and none of them is prose either');
});

test('a code-navigation marker without its argument is prose, not a broken call', () => {
  // The same rule every other argument-taking marker follows: a marker with
  // nothing after it is a shape mistake, and the shape nudge teaches it.
  assert.deepEqual(parse('SYMBOLS\nDEF\nREFS').map((c) => c.kind), []);
  assert.equal(attemptedMarker('SYMBOLS'), true, 'but it is read as an attempt');
});

test('TREE and STAT are calls, not prose', () => {
  const reply = 'TREE src -L 2\nTREE\nSTAT src/app.ts\nDONE looked';
  const calls = parse(reply);
  assert.deepEqual(calls.map((c) => [c.kind, c.arg]), [
    ['tree', 'src -L 2'],
    ['tree', ''],
    ['stat', 'src/app.ts'],
    ['done', 'looked'],
  ]);
  assert.doesNotMatch(prose(reply), /TREE|STAT/, 'the wire is not repeated as prose');
  assert.deepEqual(parse('STAT').map((c) => c.kind), [], 'a bare STAT is a shape mistake');
  assert.equal(attemptedMarker('STAT'), true, 'but it is read as an attempt');
});

test('the preamble teaches TREE and STAT only when asked', () => {
  const off = preamble({});
  assert.doesNotMatch(off, /^TREE /m, 'the tuned bytes stay untouched by default');
  assert.doesNotMatch(off, /^STAT /m);
  const on = preamble({ explore: true });
  assert.match(on, /^TREE src$/m);
  assert.match(on, /^STAT src\/app\.ts$/m);
  assert.match(on, /NEED dir src -l/);
});

test('the preamble keeps the answer itself in the message, above the DONE', () => {
  // Recorded live: a WEB-search run closed with a "summary done" line while the
  // findings never left the pasted result — a one-line bubble for a request
  // whose whole point was the summary.
  const text = preamble({});
  assert.match(text, /write the answer itself in your message/);
  assert.match(text, /findings must not live only inside what I pasted back/);
  assert.match(text, /"finished" alone is not an answer/);
});

test('a CREATE body keeps its own lowercase end lines', () => {
  // Ruby and Lua close blocks with a bare lowercase `end`; a case-blind
  // terminator ends the CREATE in the middle of the file and the fragment
  // is written silently. The canonical-uppercase terminator has to win.
  const calls = parse([
    'CREATE app.rb',
    'def greet(name)',
    '  if name',
    '    puts "hi"',
    '  end',
    'end',
    'END',
  ].join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'write');
  assert.equal(calls[0].arg, 'app.rb');
  assert.equal(calls[0].body, 'def greet(name)\n  if name\n    puts "hi"\n  end\nend');
});

test('a CREATE body keeps its own lowercase end lines in Lua', () => {
  const calls = parse([
    'CREATE main.lua',
    'local function on_frame()',
    '  if ready then',
    '    return draw()',
    '  end',
    'end',
    'END',
  ].join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arg, 'main.lua');
  assert.equal(calls[0].body, 'local function on_frame()\n  if ready then\n    return draw()\n  end\nend');
});

test('a block closed only in lowercase is unterminated, not silently closed', () => {
  // There is no case-blind fallback any more: a reply cut off mid-block (or
  // one that closed in lowercase) cannot be told apart from a truncated
  // file, so the body runs to the end of the reply and the call is flagged
  // unterminated — the loop refuses to stage it instead of writing a
  // fragment whose last line was a Ruby `end`.
  const calls = parse([
    'CREATE x.rb',
    'def x',
    '  puts 1',
    'end',
  ].join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].unterminated, true);
  assert.equal(calls[0].body, 'def x\n  puts 1\nend');
});

test('an unclosed block does not borrow the next block\'s END', () => {
  // The body stops at the next body opener: the second block's END is not
  // lent to the first, and the first block is flagged unterminated with
  // its own lines (its lowercase `end` included) instead of a fragment.
  const calls = parse([
    'CREATE a.rb',
    'def a',
    'end',
    'CREATE b.rb',
    'puts 1',
    'END',
  ].join('\n'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].arg, 'a.rb');
  assert.equal(calls[0].unterminated, true);
  assert.equal(calls[0].body, 'def a\nend');
  assert.equal(calls[1].arg, 'b.rb');
  assert.equal(calls[1].body, 'puts 1');
  assert.equal(calls[1].unterminated, undefined, 'the second block closed properly');
});

test('a RUN block closed in lowercase does not borrow the next block\'s END', () => {
  // RUN is a body opener too: its boundary protects the block behind it
  // from lending its END, the way CREATE's own boundary does — and the
  // RUN is flagged unterminated rather than closing at its own `end`.
  const calls = parse([
    'RUN',
    'for f in x; do',
    '  echo $f',
    'end',
    'CREATE b.rb',
    'puts 1',
    'END',
  ].join('\n'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'run');
  assert.equal(calls[0].unterminated, true);
  assert.equal(calls[0].body, 'for f in x; do\n  echo $f\nend');
  assert.equal(calls[1].kind, 'write');
  assert.equal(calls[1].arg, 'b.rb');
  assert.equal(calls[1].body, 'puts 1');
});

test('an EDIT FIND body keeps its own lowercase end lines', () => {
  // The same case decision serves the FIND half of an EDIT — a Ruby patch
  // read through a case-blind terminator loses the file's own ends.
  const calls = parse([
    'EDIT app.rb',
    'FIND',
    'def x',
    '  if y',
    '    puts 1',
    '  end',
    'end',
    'NEW',
    'def x',
    '  if y',
    '    puts 2',
    '  end',
    'end',
    'END',
  ].join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'replace');
  assert.deepEqual(calls[0].body, [
    'def x\n  if y\n    puts 1\n  end\nend',
    'def x\n  if y\n    puts 2\n  end\nend',
  ]);
});

test('plain sentences that start with a marker word stay prose', () => {
  // The case-blind parser read 22 of 30 ordinary English sentences that
  // begin with a marker word as commands — "Create a summary of the
  // changes." became a write of a file named `a summary of the changes.`,
  // "Ask me if anything is unclear." paused the run. Case is the whole
  // point: only the exact uppercase keyword on its own line is a call.
  const sentences = [
    'Create a summary of the changes.',
    'Delete the old build folder first.',
    'Ask me if anything is unclear.',
    'Done with the first half.',
    'Move the discussion to the next topic.',
    'Edit the sentence so it reads better.',
    'Run the numbers again tomorrow.',
    'Search me a better cat in the logs.',
    'Fetch the latest from the board.',
    'Need to check the logs before deciding.',
    'Attach the receipts to the email.',
    'Plan the trip for next month.',
    'Web design is not my department.',
    'Git is a distributed version control system.',
    'Skill issue, honestly.',
    'Verify the cake is in the oven.',
    'Glob the whole thing in butter.',
    'Recall the last time we did this.',
    'Retrieve the file from the archive.',
    'Diagnose the noise in the engine.',
    'Symbols are a good way to start.',
    'Def a variable before use.',
    'Refs are missing from the bibliography.',
    'Tree rings tell the age of a tree.',
    'Stat the river before crossing.',
    'Jobs are listed on the wall.',
    'Goal settings are in the menu.',
    'Subagent smith handled the photos.',
    'Skip the step and continue.',
    'Todo is done when it is done.',
  ];
  for (const sentence of sentences) {
    assert.deepEqual(parse(sentence), [], `a sentence is not a call: ${sentence}`);
    assert.equal(prose(sentence), sentence, `and it survives the prose filter: ${sentence}`);
  }
});

test('lowercase markers are prose too — the keyword must be uppercase', () => {
  for (const line of ['create notes.md', 'edit notes.md', 'delete old.txt', 'run the tests', 'need file a.txt', 'search the codebase', 'done for today', 'ask the user first']) {
    assert.deepEqual(parse(line), [], `not a call: ${line}`);
  }
  // The exact uppercase shapes still parse.
  assert.deepEqual(parse('NEED file a.txt').map((c) => c.kind), ['read']);
  assert.deepEqual(parse('DONE finished').map((c) => c.kind), ['done']);
  assert.deepEqual(parse('## DONE shipped').map((c) => c.kind), ['done']);
  assert.deepEqual(parse('**DONE** shipped').map((c) => c.kind), ['done']);
});

test('DONE is uppercase-only: "Done." with no work is a nudge, not an ending', () => {
  // Owner decision, pinned: keeping DONE case-insensitive would let a run
  // that has used no tool at all end on the sentence "Done." — exactly the
  // failure the case-blind parser had. The loop's closing-sentence rule
  // (toolsRun > 0) still ends a run after real work; a bare "Done." first
  // earns the nudge that teaches the uppercase shape.
  assert.deepEqual(parse('Done.'), []);
  assert.deepEqual(parse('Done with that.'), []);
  assert.equal(prose('Done with that.'), 'Done with that.');
  assert.deepEqual(parse('DONE with that.').map((c) => c.kind), ['done']);
});

test('a block whose END never arrives is flagged unterminated', () => {
  const created = parse('CREATE notes.md\nline one\nline two');
  assert.equal(created[0].kind, 'write');
  assert.equal(created[0].unterminated, true);
  assert.equal(created[0].body, 'line one\nline two', 'the body is everything the reply carried');

  const edited = parse('EDIT a.js\nFIND\nold\nNEW\nnew');
  assert.equal(edited[0].kind, 'replace');
  assert.equal(edited[0].unterminated, true);

  const ran = parse('RUN\nnode check.mjs');
  assert.equal(ran[0].kind, 'run');
  assert.equal(ran[0].unterminated, true);
  assert.equal(ran[0].body, 'node check.mjs');

  const closed = parse('CREATE notes.md\nline one\nEND');
  assert.equal(closed[0].unterminated, undefined, 'a properly closed block carries no flag');
});
