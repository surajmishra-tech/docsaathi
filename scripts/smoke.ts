// End-to-end smoke test over real HTTP: starts DocSaathi on a fresh in-memory database and
// plays the demo story through two MCP clients (spec 2025-11-25 "legacy" and 2026-07-28 "modern").
// Usage: npm run smoke
process.env.DOCSAATHI_DB = ':memory:';
process.env.PORT = process.env.SMOKE_PORT ?? '3999';

const { start } = await import('../src/server/index.js');
const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

type ToolResult = { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const server = await start(Number(process.env.PORT));
const url = new URL(`http://127.0.0.1:${process.env.PORT}/mcp`);
const headers = { Authorization: 'Bearer demo-verma-family' };

async function connect(mode: 'legacy' | 'modern') {
  const client = new Client(
    { name: `docsaathi-smoke-${mode}`, version: '1.0.0' },
    mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ->  ${detail}` : ''}`);
}

async function call(client: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const speech = res.content?.[0]?.text ?? '';
  console.log(`\n>>> ${name} ${JSON.stringify(args)}\n    Alexa: ${speech}`);
  return { res, speech, data: (res.structuredContent ?? {}) as Record<string, any> };
}

try {
  // 1. Both protocol eras can connect and see the tools.
  const legacy = await connect('legacy');
  const legacyTools = await legacy.listTools();
  check('2025-11-25 (legacy) client lists tools', legacyTools.tools.length >= 12, `${legacyTools.tools.length} tools`);
  const modern = await connect('modern');
  const modernTools = await modern.listTools();
  check('2026-07-28 (modern) client lists tools', modernTools.tools.length >= 12, `${modernTools.tools.length} tools`);

  // 2. Scene 1: find a child doctor, in Hinglish, near home, this evening.
  const find = await call(legacy, 'find_doctors', { need: 'Aarav ko bukhaar hai, aaj shaam paas mein bachchon ka doctor chahiye', patient: 'Aarav' });
  const doctors = (find.data.doctors ?? []) as Array<{ name: string; specialty: string; ref: string; slots: Array<{ start: string }> }>;
  check('understood "bachchon ka doctor" as Pediatrician', find.data.understood?.specialty === 'Pediatrician');
  check('found child doctors on the UHI test network', doctors.length > 0 && doctors.every((d) => d.specialty === 'Pediatrician'), doctors.map((d) => d.name).join(', '));
  console.log(`    Google nearby clinics: ${(find.data.nearbyOnGoogle ?? []).map((g: any) => `${g.name} (${g.phone ?? 'no phone'})`).join('; ') || 'none (no key or none found)'}`);

  // 3. Scene 2: hold the first doctor's first time, then confirm (modern client, to show both eras share state).
  const hold = await call(modern, 'book_appointment', { doctor: '1', patient: 'Aarav' });
  check('book_appointment returns a confirm card with hold id', hold.data.kind === 'confirm' && Boolean(hold.data.holdId), String(hold.data.holdId));
  const booked = await call(modern, 'confirm_appointment', { hold_id: hold.data.holdId });
  check('confirm_appointment books it over UHI (CONFIRMED)', booked.data.kind === 'booked' && booked.data.state === 'CONFIRMED', String(booked.data.uhiOrderId));
  check('family message sent to Papa', (booked.data.messages ?? []).some((m: any) => /Papa/.test(m.to)));

  // 4. The same time can't be booked twice.
  const again = await call(legacy, 'find_doctors', { need: 'bachchon ka doctor', patient: 'Aarav', when: 'aaj shaam' });
  const firstRef = doctors[0]?.ref;
  const sameDoctor = ((again.data.doctors ?? []) as typeof doctors).find((d) => d.ref === firstRef);
  const bookedStart = booked.data.summary?.start;
  check('booked time no longer offered', !sameDoctor || !sameDoctor.slots.some((s) => s.start === bookedStart));

  // 5. Scene 3: Dadi's usual sugar doctor (memory from a past visit).
  const usual = await call(legacy, 'find_usual_doctor', { patient: 'Dadi', need: 'sugar check-up', when: 'kal subah' });
  check('remembers Dadi usually sees Dr. Rakesh Sharma', /Rakesh Sharma/.test(usual.speech));
  const holdDadi = await call(legacy, 'book_appointment', { doctor: 'Sharma', patient: 'Dadi' });
  check('clinic instructions included (fasting)', /fasting/i.test(holdDadi.speech));
  const bookedDadi = await call(legacy, 'confirm_appointment', {});
  check('Dadi booked', bookedDadi.data.kind === 'booked');

  // 6. Scene 4: follow-up memory + time jump.
  const fu = await call(modern, 'remember_follow_up', { patient: 'Dadi', after: '3 months' });
  check('follow-up remembered', fu.data.kind === 'follow-up');
  await fetch(`http://127.0.0.1:${process.env.PORT}/api/demo/time-jump`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 90 }) });
  const due = await call(modern, 'check_reminders', {});
  check('3 months later: check-up is due', (due.data.reminders ?? []).length > 0);
  await fetch(`http://127.0.0.1:${process.env.PORT}/api/demo/time-reset`, { method: 'POST' });

  // 7. Scene 5: emergency words never book.
  const emergency = await call(legacy, 'find_doctors', { need: 'Papa ke seene mein dard hai', patient: 'Papa' });
  check('chest pain -> emergency numbers, no doctors', emergency.data.kind === 'emergency' && /112/.test(emergency.speech));

  // 8. Appointments list + cancel.
  const list = await call(legacy, 'my_appointments', {});
  check('family has 2 upcoming appointments', (list.data.appointments ?? []).length === 2);
  const cancel = await call(legacy, 'cancel_appointment', { appointment: 'Aarav' });
  check('cancel Aarav’s appointment over UHI', cancel.data.kind === 'cancelled');

  // 9. Unknown relation asks a question instead of guessing.
  const unknown = await call(legacy, 'find_doctors', { need: 'daant ka doctor', patient: 'Chacha' });
  check('unknown relation -> asks to add them', unknown.data.kind === 'question');

  await legacy.close();
  await modern.close();
} catch (err) {
  failures++;
  console.error('Smoke test crashed:', err);
} finally {
  server.close();
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
