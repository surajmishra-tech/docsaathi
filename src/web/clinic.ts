// Clinic desk: lists the bookings families made on Alexa with the test clinics, and lets the
// receptionist accept each one or say why the clinic can't take it.
interface Booking {
  id: string;
  patient: string;
  phone: string | null;
  doctor: string;
  specialty: string;
  clinic: string;
  address: string;
  start: string;
  status: 'confirmed' | 'cancelled';
  decision: 'new' | 'accepted' | 'rejected';
  note: string | null;
  bookedAt: string;
}

const list = document.getElementById('list') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLElement;
const HEADERS = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' };
const REASONS = ['Doctor not available at that time', 'Clinic closed that day', 'Please come at another time'];
const seen = new Set<string>();
let first = true;

const clean = (name: string) => name.replace(/\s*\(TEST\)\s*$/, '');
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function stateLabel(b: Booking): [string, string] {
  if (b.decision === 'accepted') return ['accepted', 'Accepted: the family has been told'];
  if (b.decision === 'rejected') return ['rejected', `Not taken${b.note ? `: ${b.note}` : ''}`];
  if (b.status === 'cancelled') return ['cancelled', 'Cancelled by the family'];
  return ['new', 'New: waiting for you'];
}

function row(b: Booking): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `item${!first && !seen.has(b.id) ? ' fresh' : ''}`;
  const [cls, label] = stateLabel(b);
  const info = document.createElement('div');
  const lines: Array<[string, string]> = [
    ['when', when(b.start)],
    ['who', b.patient.replace(/ \(.*\)$/, '') + (b.phone ? ` · ${b.phone}` : '')],
    ['meta', `${b.doctor} · ${b.specialty} · ${clean(b.clinic)}`],
  ];
  for (const [c, text] of lines) {
    const p = document.createElement('div');
    p.className = c;
    p.textContent = text;
    info.append(p);
  }
  const chip = document.createElement('span');
  chip.className = `state ${cls}`;
  chip.textContent = label;
  info.append(chip);
  li.append(info);

  if (b.status === 'confirmed' && b.decision === 'new') {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const accept = document.createElement('button');
    accept.className = 'btn accept';
    accept.textContent = 'Accept';
    const reason = document.createElement('select');
    reason.setAttribute('aria-label', 'Why the clinic cannot take it');
    for (const r of REASONS) reason.append(new Option(r, r));
    const reject = document.createElement('button');
    reject.className = 'btn reject';
    reject.textContent = "Can't take it";
    const decide = async (decision: 'accept' | 'reject') => {
      accept.disabled = reject.disabled = true;
      try {
        const res = await fetch(`/clinic/api/bookings/${encodeURIComponent(b.id)}/${decision}`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ reason: reason.value }) });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        alert('Could not save that. Please try again.');
      }
      await refresh();
    };
    accept.addEventListener('click', () => void decide('accept'));
    reject.addEventListener('click', () => void decide('reject'));
    actions.append(accept, reason, reject);
    li.append(actions);
  }
  return li;
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/clinic/api/bookings', { headers: HEADERS });
    const bookings = (await res.json()) as Booking[];
    // Keep a half-open reason menu from being redrawn under the receptionist's finger.
    if (document.activeElement?.tagName === 'SELECT') return;
    list.replaceChildren(...bookings.map(row));
    empty.hidden = bookings.length > 0;
    for (const b of bookings) seen.add(b.id);
    first = false;
  } catch {
    // the server is restarting: try again on the next tick
  }
}

void refresh();
setInterval(() => void refresh(), 3000);
