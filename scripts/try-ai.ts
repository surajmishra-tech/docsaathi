// Talks to the AI brain (BRAIN=groq) the way a family would, on a fresh in-memory copy of DocSaathi
// (it does not touch your running app). Shows which model understood each sentence, and when the
// rule brain had to take over. Needs GROQ_API_KEY in .env.
// Usage: npx tsx scripts/try-ai.ts            (add GROQ_MODELS=... to try another model order)
process.env.DOCSAATHI_DB = ':memory:';
process.env.BRAIN = 'groq';
process.env.PORT = process.env.TRY_PORT ?? '3991';
process.env.SANDBOX_PORT = process.env.TRY_SANDBOX_PORT ?? '3990';

const { start } = await import('../src/server/index.js');
const base = `http://127.0.0.1:${process.env.PORT}`;
const server = await start(Number(process.env.PORT));
await (await import('./link.js')).linkSimulator(base); // DocSaathi linked to this Echo (OAuth), as after the Alexa app
const pause = Number(process.env.TRY_PAUSE_MS ?? 5000); // the free plan allows about 8 requests a minute per model

// TRY_SET=2 runs the second set (Hindi script, moving and cancelling, questions about the list).
const SETS: Record<string, string[][]> = {
  '2': [
    ['नमस्ते', 'पापा के घुटने में बहुत दर्द है, हड्डी के डॉक्टर को दिखाना है', 'पहला वाला', 'कल शाम छह बजे', 'हाँ'],
    [
      'Aarav ke liye kal shaam bachchon ke doctor ka time le lo',
      'fees kitni hai doosre doctor ki?',
      'Dr. Mehta',
      '6 baje',
      'haan',
      'mere appointments dikhao',
      'Aarav ka appointment parso shaam kar do',
      'Aarav wala appointment cancel kar do',
    ],
    ['I need a skin specialist', 'for me', 'is there a lady doctor?', 'ok the first one, earliest time please', 'no leave it', 'thanks, bas itna hi'],
  ],
  // TRY_SET=4: nobody is assumed to be talking; Alexa asks, remembers, and forgets after "bye".
  '4': [
    [
      'Hello',
      'yaar meri tabiyat theek nahi hai, bukhar bhi hai',
      'Papa',
      'aur meri aankh bhi check karwani hai',
      'mere appointments dikhao',
      'theek hai bye',
      'main Dadi hoon, mere ghutno mein bahut dard rehta hai',
      'mujhe kal subah dikhana hai',
    ],
  ],
  // TRY_SET=3: Alexa answers in Hindi, real clinics, and back to English.
  '3': [
    [
      'Hindi mein bolo',
      'yaar meri tabiyat kuch theek nahi lag rahi',
      'sar mein dard hai aur chakkar aa rahe hain',
      'pehla wala',
      'kal subah 10 baje',
      'haan',
      'aaj mausam kaisa hai?',
      'paas mein koi asli clinic hai jahan phone kar saku?',
      'speak in English',
      'what did I book?',
    ],
  ],
};

const conversations: string[][] = SETS[process.env.TRY_SET ?? ''] ?? [
  [
    'Hello Alexa',
    'yaar meri tabiyat kuch theek nahi lag rahi',
    'pet mein bahut dard ho raha hai subah se',
    'pehle wale doctor se milna hai',
    'kal subah saadhe das baje',
    'haan pakka kar do',
  ],
  [
    'meri beti ke daant mein dard hai, kal ke liye doctor dikha do',
    'uska naam Riya hai, 9 saal ki hai',
    'pehla wala theek hai, shaam 5 baje',
    'abhi rehne do, baad mein batati hoon',
  ],
  [
    'dadi ka sugar wala checkup karwana hai kal subah',
    'haan',
    'haan book kar do',
    'doctor ne bola tha 3 mahine baad dadi ko dobara dikhana hai',
    'bukhaar ke liye kaun si goli lu?',
    'papa ke seene mein dard ho raha hai',
    'hum Rohini Delhi mein rehte hain',
    'aaj ka mausam kaisa hai?',
    'theek hai bye',
  ],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ai = 0;
let rules = 0;
try {
  for (const lines of conversations) {
    await fetch(`${base}/api/demo/reset`, { method: 'POST' });
    console.log('\n==================== new conversation ====================');
    for (const line of lines) {
      const started = Date.now();
      const res = await fetch(`${base}/api/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: line }) });
      const body = (await res.json()) as { speech: string; kind: string; by?: string; tool: { name: string; arguments: Record<string, unknown> } | null };
      if (body.by === 'rules') rules++;
      else ai++;
      console.log(`\nYOU:   ${line}`);
      console.log(`ALEXA: ${body.speech}`);
      console.log(`       [${body.kind}${body.tool ? ` / ${body.tool.name} ${JSON.stringify(body.tool.arguments)}` : ''}]  by ${body.by}  ${Date.now() - started} ms`);
      await sleep(pause);
    }
  }
  console.log(`\nUnderstood by the AI: ${ai} turns. By the rule brain: ${rules} turns.`);
} finally {
  server.close();
  process.exit(0);
}
