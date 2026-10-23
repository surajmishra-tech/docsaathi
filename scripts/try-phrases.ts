// Try a list of sentences against a fresh in-memory copy of DocSaathi (does not touch your running app).
// Usage: npx tsx scripts/try-phrases.ts
process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN ??= 'demo'; // the built-in rules, unless you start it with BRAIN=groq
process.env.PORT = process.env.TRY_PORT ?? '3993';
process.env.SANDBOX_PORT = process.env.TRY_SANDBOX_PORT ?? '3992';

const { start } = await import('../src/server/index.js');
const base = `http://127.0.0.1:${process.env.PORT}`;
const server = await start(Number(process.env.PORT));
await (await import('./link.js')).linkSimulator(base); // DocSaathi linked to this Echo (OAuth), as after the Alexa app

const lines: Array<string | { action: 'jump' | 'reset' }> = [
  'Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye',
  'Marathi bolne wale bachchon ka doctor',
  'Pehla wala',
  'Aarav',
  'Haan',
  'Haan',
  'I need a skin doctor for me tomorrow evening',
  'Pehla wala',
  'Nahi',
  'Chacha ke liye daant ka doctor',
  'Chacha ka naam Ramesh hai, 50 saal',
  'Chacha ke liye daant ka doctor',
  'Pehla wala',
  'Haan',
  'family members',
  'Mummy ke liye ladies doctor',
  'Dadi ke liye sugar wale doctor',
  'Haan',
  'Haan, book kar do',
  'my appointments',
]

try {
  for (const line of lines) {
    if (typeof line !== 'string') {
      await fetch(`${base}/api/demo/${line.action === 'jump' ? 'time-jump' : 'reset'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 14 }) });
      console.log(`\n[demo: ${line.action === 'jump' ? 'jumped 14 days' : 'reset'}]`);
      continue;
    }
    const res = await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: line }) });
    const body = (await res.json()) as { speech: string; kind: string; tool: { name: string } | null };
    console.log(`\nYOU:   ${line}\nALEXA: ${body.speech}\n       [${body.kind}${body.tool ? ` / ${body.tool.name}` : ''}]`);
  }
} finally {
  server.close();
  process.exit(0);
}
