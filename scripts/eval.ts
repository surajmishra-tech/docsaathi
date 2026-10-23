// Accuracy test: plays every sentence in eval-cases.ts to Alexa (the simulator's brain, calling DocSaathi
// over MCP with the family's OAuth token) on a fresh in-memory copy, and scores what happened.
// Writes the report to docs/eval-<brain>.md.
// Usage: npm run eval                 (built-in rules, offline, same answers every run)
//        EVAL_BRAIN=groq npm run eval (the AI brain; needs GROQ_API_KEY, slow on the free plan)
//        npm run eval:bedrock         (Claude on Amazon Bedrock, new sentences only; works in every shell)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASES, NEW_CASES, type EvalCase, type Group, type Lang } from './eval-cases.js';

// The brain and the set can also be given as words (tsx scripts/eval.ts bedrock new), which works in
// PowerShell and cmd too, where "EVAL_BRAIN=... npm run eval" does not.
const [brainArg, setArg] = process.argv.slice(2);
if (brainArg) process.env.EVAL_BRAIN = brainArg;
if (setArg) process.env.EVAL_SET = setArg;
process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN = process.env.EVAL_BRAIN ?? 'demo';
process.env.PORT = process.env.EVAL_PORT ?? '3987';
process.env.SANDBOX_PORT = process.env.EVAL_SANDBOX_PORT ?? '3986';
const AI = process.env.BRAIN !== 'demo';
// Free AI plans (Groq) allow a few requests a minute; Bedrock allows many more.
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS ?? (!AI ? 0 : process.env.BRAIN === 'bedrock' ? 1500 : 9000));

const { start } = await import('../src/server/index.js');
const { brainLabel } = await import('../src/server/brain/index.js');
const { linkSimulator } = await import('./link.js');

const base = `http://127.0.0.1:${process.env.PORT}`;
const server = await start(Number(process.env.PORT));
await linkSimulator(base);
const brain = brainLabel();

type Reply = {
  speech: string;
  kind: string;
  by?: string;
  tool: { name: string; result: { structuredContent?: Record<string, any> } } | null;
};

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function say(text: string): Promise<Reply> {
  if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
  return (await (await post('/api/assistant', { text })).json()) as Reply;
}

function specialtyOf(data: Record<string, any> | undefined): string | undefined {
  return data?.understood?.specialty ?? data?.doctor?.specialty ?? data?.doctors?.[0]?.specialty;
}

const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/** What went wrong (empty = passed). */
function judge(c: EvalCase, r: Reply): string[] {
  const e = c.expect;
  const data = r.tool?.result.structuredContent;
  const wrong: string[] = [];
  const kinds = list(e.kind);
  // The AI brain asks its questions as plain talk ("What is your sister's name?"): that is a question too.
  const asks = r.kind === 'chat' && !r.tool && r.speech.includes('?');
  if (kinds && !kinds.includes(r.kind) && !(asks && kinds.includes('question'))) wrong.push(`did "${r.kind}", expected ${kinds.join(' or ')}`);
  if (e.notKind && r.kind === e.notKind) wrong.push(`must not be "${e.notKind}"`);
  if (e.tool && r.tool?.name !== e.tool) wrong.push(`tool ${r.tool?.name ?? 'none'}, expected ${e.tool}`);
  const specialties = list(e.specialty);
  const got = specialtyOf(data);
  if (specialties && !(got && specialties.includes(got))) wrong.push(`doctor ${got ?? 'none'}, expected ${specialties.join(' or ')}`);
  if (e.patient && !e.patient.test(String(data?.patient ?? ''))) wrong.push(`for ${data?.patient || 'nobody'}, expected ${e.patient.source}`);
  if (e.speech && !e.speech.test(r.speech)) wrong.push(`did not say ${e.speech.source}`);
  if (e.speechNot && e.speechNot.test(r.speech)) wrong.push(`said something it must not (${r.speech.match(e.speechNot)?.[0]})`);
  return wrong;
}

interface Result {
  set: 'main' | 'new';
  c: EvalCase;
  r: Reply;
  wrong: string[];
  ms: number;
}

const results: Result[] = [];
try {
  const family = (await (await fetch(`${base}/api/family`)).json()) as { members: Array<{ id: string; label: string }> };
  // The location case moves the family's home, so it stays the very last one.
  const all = [
    ...CASES.slice(0, -1).map((c) => ['main', c] as const),
    ...NEW_CASES.map((c) => ['new', c] as const),
    ['main', CASES[CASES.length - 1]] as const,
  ];
  // EVAL_SET=new runs only the new sentences (to save a free AI plan's daily requests).
  for (const [set, c] of all.filter(([set]) => !process.env.EVAL_SET || set === process.env.EVAL_SET)) {
    await post('/api/demo/reset');
    if (c.speaker) {
      const member = family.members.find((m) => m.label.startsWith(c.speaker!));
      await post('/api/family/speaker', { member: member?.id ?? null });
    }
    for (const line of c.before ?? []) await say(line);
    const t0 = performance.now();
    const r = await say(c.say);
    const ms = performance.now() - t0 - PAUSE_MS;
    const wrong = judge(c, r);
    results.push({ set, c, r, wrong, ms });
    console.log(`${wrong.length ? 'FAIL' : 'PASS'}  [${c.group} · ${c.lang}] ${c.say}\n      -> ${r.kind}${r.tool ? ` via ${r.tool.name}` : ''}${r.by && AI ? ` (${r.by})` : ''}: ${r.speech.slice(0, 120)}${wrong.length ? `\n      ✗ ${wrong.join('; ')}` : ''}`);
  }
} finally {
  server.close();
}

// ---------------------------------------------------------------------------
// The report

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const passed = results.filter((x) => !x.wrong.length).length;
const main = results.filter((x) => x.set === 'main');
const fresh = results.filter((x) => x.set === 'new');
const ok = (xs: Result[]) => xs.filter((x) => !x.wrong.length).length;
const tally = <K extends string>(key: (x: Result) => K) => {
  const m = new Map<K, { ok: number; all: number }>();
  for (const x of results) {
    const t = m.get(key(x)) ?? { ok: 0, all: 0 };
    t.all++;
    if (!x.wrong.length) t.ok++;
    m.set(key(x), t);
  }
  return m;
};
const ms = results.map((x) => x.ms).sort((a, b) => a - b);
const median = ms[Math.floor(ms.length / 2)] ?? 0;
const p95 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] ?? 0;
const fellBack = AI ? results.filter((x) => x.r.by === 'rules').length : 0;
// Who answered: with BRAIN=bedrock, Groq answers a turn when Bedrock cannot, so the score says whose it is.
const answeredBy = [...tally((x) => (x.r.by ?? 'ai') as string)].map(([by, t]) => `${by} ${t.all}`).join(', ');
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const lines = [
  `# Accuracy: ${brain}`,
  '',
  `**${passed} of ${results.length} correct (${pct(passed, results.length)})**. Run on ${new Date().toISOString().slice(0, 10)} with \`${AI ? `EVAL_BRAIN=${process.env.BRAIN} ` : ''}npm run eval\`.`,
  '',
  main.length
    ? `- Main set: ${ok(main)} / ${main.length} (${pct(ok(main), main.length)}). Its first run with the rule brain (17 Oct 2026) scored 61 / 70. The misses were real gaps`
    : '- Main set: not run this time (EVAL_SET=new). The notes below are about the rule brain.',
  '  (emergency words, "mere bete", curly apostrophes typed on phones, a bug that changed "कल" inside other Hindi words), and the rules were fixed.',
  `- New sentences: ${ok(fresh)} / ${fresh.length} (${pct(ok(fresh), fresh.length)}), written after those fixes. Their first run scored 25 / 33 with the rule brain.`,
  '  Three of those misses were emergencies ("isn’t waking up", a swallowed bottle of medicine, "saans phool rahi hai"), so those words were',
  '  added: safety comes before a clean score. The other misses are left as they are; they show where the rules stop and the AI brain is needed.',
  '',
  'Each sentence is said to the simulator\'s Alexa on a fresh conversation, the way a family would say it. Alexa calls DocSaathi\'s',
  'MCP tools with the family\'s OAuth token, and the result is checked: the kind of doctor, who it is for, emergency handling,',
  'that nothing is booked without a yes, and that no medicine is ever named. The sentences are in',
  '[scripts/eval-cases.ts](../scripts/eval-cases.ts).',
  '',
  '| Group | Correct |',
  '|---|---|',
  ...[...tally((x) => x.c.group as Group)].map(([g, t]) => `| ${g} | ${t.ok} / ${t.all} (${pct(t.ok, t.all)}) |`),
  '',
  '| Language | Correct |',
  '|---|---|',
  ...[...tally((x) => x.c.lang as Lang)].map(([l, t]) => `| ${l} | ${t.ok} / ${t.all} (${pct(t.ok, t.all)}) |`),
  '',
  `Reply time (the whole turn: understanding + MCP tool + UHI test network${AI ? ' + AI model' : ''}): median **${Math.round(median)} ms**, 95th percentile ${Math.round(p95)} ms.`,
  ...(AI
    ? [
        '',
        `Who answered the sentences: ${answeredBy}.`,
        '',
        `Turns answered by the built-in rules: ${fellBack}. By design they answer emergencies, yes/no and choices on the screen first,`,
        'and they also take over when the AI model is busy (free-plan limit).',
        '',
        'History: the first AI run (17 Oct 2026, Groq gpt-oss-120b, new sentences) scored 20 / 33. The model asked questions it did not',
        'need ("When would you like the appointment?", "Which family member?" when Papa was named) instead of searching. Its instructions',
        'now say to search as soon as the problem and the person are known, and to add the kind of doctor in English when it knows it.',
      ]
    : []),
  '',
  '## Every sentence',
  '',
  '| | Set | Group | Language | They said | Alexa did | What was wrong |',
  '|---|---|---|---|---|---|---|',
  ...results.map(
    (x) =>
      `| ${x.wrong.length ? '✗' : '✓'} | ${x.set} | ${x.c.group} | ${x.c.lang} | ${cell((x.c.before?.length ? `(after: ${x.c.before.join(' → ')}) ` : '') + x.c.say)} | ${cell(
        `${x.r.kind}${x.r.tool ? ` (${x.r.tool.name}${specialtyOf(x.r.tool.result.structuredContent) ? `: ${specialtyOf(x.r.tool.result.structuredContent)}` : ''}${x.r.tool.result.structuredContent?.patient ? `, for ${x.r.tool.result.structuredContent.patient}` : ''})` : ''}`,
      )} | ${cell(x.wrong.join('; '))} |`,
  ),
  '',
];
const file = resolve('docs', `eval-${process.env.BRAIN}.md`);
writeFileSync(file, lines.join('\n'));
console.log(`\nMain set ${ok(main)} / ${main.length}, new sentences ${ok(fresh)} / ${fresh.length}. ${passed} / ${results.length} correct (${pct(passed, results.length)}). Median ${Math.round(median)} ms.${AI ? ` Answered by: ${answeredBy}.` : ''} Report: ${file}`);
process.exit(0);
