// Links the simulated Echo to DocSaathi the way a person does on the page (Link account -> sign in
// with the family's mobile number and PIN -> back to Alexa), but over plain HTTP, for test scripts.
export async function linkSimulator(base: string, mobile = '00000 11111', pin = process.env.FAMILY_LINK_PIN ?? '1234'): Promise<void> {
  const start = await fetch(`${base}/alexa/link/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location') ?? '', base);
  const signIn = await fetch(authorize);
  const request = (await signIn.text()).match(/name="request" value="([^"]+)"/)?.[1];
  if (!signIn.ok || !request) throw new Error(`The sign-in page did not open (HTTP ${signIn.status})`);
  const allow = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, mobile, pin, action: 'allow' }),
  });
  const back = allow.headers.get('location');
  if (allow.status !== 302 || !back) throw new Error(`Sign-in was refused (HTTP ${allow.status})`);
  const done = await fetch(back);
  if (!done.ok) throw new Error(`Alexa could not finish linking: ${(await done.text()).match(/data-linked="false">([^<]+)/)?.[1] ?? done.status}`);
}
