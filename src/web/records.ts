// The menu's health record pages: "Doctors we visited" and "Medicine records".
// Everything the family typed is shown with textContent (never as HTML).

type Api = (path: string, init?: RequestInit) => Promise<Response>;
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Visit {
  id: string;
  source: 'docsaathi' | 'family';
  memberId: string;
  patient: string | null;
  doctor: string;
  specialty: string | null;
  clinic: string | null;
  date: string;
  notes?: string | null;
  addedBy?: string | null;
  testData?: boolean;
}

interface Medicine {
  id: string;
  memberId: string;
  patient: string | null;
  name: string;
  howToTake: string | null;
  days: number | null;
  doctor: string | null;
  startedOn: string;
  notes: string | null;
  addedBy: string | null;
  daysLeft: number | null;
  current: boolean;
}

interface HealthRecord {
  today: string;
  members: Array<{ id: string; label: string; age: number | null }>;
  upcoming: Visit[];
  visits: Visit[];
  medicines: Medicine[];
}

const KINDS = ['General Physician', 'Pediatrician', 'Diabetologist', 'Cardiologist', 'Orthopedic', 'Dentist', 'Eye Specialist', 'Dermatologist', 'ENT Specialist', 'Gynecologist', 'Psychiatrist'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: { [k: string]: string } = {}, ...kids: Array<Node | string | null | undefined>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) e.append(kid);
  return e;
}

/** "19 Jul 2026" (or with the time, for appointments). */
function when(value: string, withTime = false): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return withTime ? `${date}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : date;
}

const first = (label: string | null) => (label ?? '').split(' (')[0];

export function recordPages(api: Api, pages: { visits: HTMLElement; medicines: HTMLElement }) {
  let data: HealthRecord | null = null;
  let who = ''; // member id the pages are filtered to ('' = everyone)
  let shown: 'visits' | 'medicines' | null = null;

  async function load(): Promise<void> {
    const res = await api('/api/records');
    data = res.ok ? ((await res.json()) as HealthRecord) : null;
  }

  async function send(path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<string | null> {
    const res = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const answer = (await res.json().catch(() => ({}))) as Any;
    if (!res.ok) return String(answer.error ?? `Could not save (HTTP ${res.status}).`);
    data = answer as HealthRecord;
    render();
    return null;
  }

  function filters(): HTMLElement {
    const row = el('div', { class: 'chips rec-filter', role: 'group', 'aria-label': 'Show the record of' });
    const chip = (id: string, label: string) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(who === id) }, label);
      b.addEventListener('click', () => {
        who = id;
        render();
      });
      return b;
    };
    row.append(chip('', 'Everyone'), ...(data?.members ?? []).map((m) => chip(m.id, first(m.label))));
    return row;
  }

  const mine = <T extends { memberId: string }>(items: T[]) => (who ? items.filter((i) => i.memberId === who) : items);

  function memberSelect(): HTMLSelectElement {
    const select = el('select', { name: 'memberId', required: '' });
    for (const m of data?.members ?? []) select.append(new Option(m.label, m.id, false, m.id === who));
    return select;
  }

  function field(label: string, input: HTMLElement): HTMLElement {
    return el('label', { class: 'rec-field' }, el('span', {}, label), input);
  }

  function form(title: string, fields: HTMLElement[], onSave: (values: Any) => Promise<string | null>): HTMLElement {
    const box = el('details', { class: 'rec-add' });
    const f = el('form', {});
    const error = el('p', { class: 'rec-error', role: 'alert' });
    error.hidden = true;
    f.append(...fields, error, el('button', { type: 'submit', class: 'rec-save' }, 'Save'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(f).entries());
      const problem = await onSave(values);
      error.hidden = !problem;
      error.textContent = problem ?? '';
    });
    box.append(el('summary', {}, `+ ${title}`), f);
    return box;
  }

  function removeButton(path: string, what: string): HTMLButtonElement {
    const b = el('button', { type: 'button', class: 'rec-remove', 'aria-label': `Remove ${what}` }, 'Remove');
    b.addEventListener('click', async () => {
      if (window.confirm(`Remove ${what} from the record?`)) await send(path, 'DELETE');
    });
    return b;
  }

  function shareButton(): HTMLButtonElement {
    const b = el('button', { type: 'button', class: 'rec-share' }, 'Share with a doctor (WhatsApp)');
    b.addEventListener('click', () => {
      if (!data) return;
      const people = who ? data.members.filter((m) => m.id === who) : data.members;
      const lines: string[] = ['Health record from DocSaathi'];
      for (const p of people) {
        const meds = data.medicines.filter((m) => m.memberId === p.id && m.current);
        const seen = data.visits.filter((v) => v.memberId === p.id).slice(0, 5);
        if (!meds.length && !seen.length) continue;
        lines.push('', `${p.label}${p.age ? `, ${p.age} years` : ''}`);
        if (meds.length) {
          lines.push('Medicines now:');
          for (const m of meds) lines.push(`- ${m.name}${m.howToTake ? `: ${m.howToTake}` : ''}${m.doctor ? ` (${m.doctor}, from ${when(m.startedOn)})` : ` (from ${when(m.startedOn)})`}`);
        }
        if (seen.length) {
          lines.push('Doctors seen:');
          for (const v of seen) lines.push(`- ${when(v.date)}: ${v.doctor}${v.specialty ? `, ${v.specialty}` : ''}`);
        }
      }
      if (lines.length === 1) lines.push('', 'Nothing saved yet.');
      window.open(`https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`, '_blank', 'noopener');
    });
    return b;
  }

  function visitCard(v: Visit, upcoming: boolean): HTMLElement {
    const meta = [v.specialty, v.clinic, v.patient ? `for ${first(v.patient)}` : null].filter(Boolean).join(' · ');
    const source = v.source === 'docsaathi' ? `Booked on DocSaathi${v.testData ? ' (test clinic)' : ''}` : `Added${v.addedBy ? ` by ${first(v.addedBy)}` : ''}`;
    return el(
      'div',
      { class: 'rec-card' },
      el('p', { class: 'rec-date' }, when(v.date, upcoming || v.source === 'docsaathi')),
      el('p', { class: 'rec-name' }, v.doctor),
      el('p', { class: 'rec-meta' }, meta),
      v.notes ? el('p', { class: 'rec-meta' }, v.notes) : null,
      el('p', { class: 'rec-source' }, source),
      v.source === 'family' ? removeButton(`/api/records/visits/${encodeURIComponent(v.id)}`, `the visit to ${v.doctor}`) : null,
    );
  }

  function medicineCard(m: Medicine): HTMLElement {
    const left = m.daysLeft === null ? 'ongoing' : m.current ? `${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'} left` : 'finished';
    const meta = [m.patient ? `for ${first(m.patient)}` : null, m.doctor, `from ${when(m.startedOn)}`, m.days ? `${m.days} days` : null].filter(Boolean).join(' · ');
    return el(
      'div',
      { class: `rec-card${m.current ? '' : ' done'}` },
      el('p', { class: 'rec-name' }, m.name, el('span', { class: `rec-badge${m.current ? '' : ' done'}` }, left)),
      m.howToTake ? el('p', { class: 'rec-how' }, m.howToTake) : null,
      el('p', { class: 'rec-meta' }, meta),
      m.notes ? el('p', { class: 'rec-meta' }, m.notes) : null,
      m.addedBy ? el('p', { class: 'rec-source' }, `Added by ${first(m.addedBy)}`) : null,
      removeButton(`/api/records/medicines/${encodeURIComponent(m.id)}`, m.name),
    );
  }

  function section(title: string, cards: HTMLElement[], empty: string): HTMLElement {
    return el('section', { class: 'rec-section' }, el('h3', {}, title), ...(cards.length ? cards : [el('p', { class: 'note' }, empty)]));
  }

  function renderVisits(): void {
    const page = pages.visits;
    if (!data) {
      page.replaceChildren(el('p', { class: 'note' }, 'Could not load the record. Please try again.'));
      return;
    }
    const doctorInput = el('input', { name: 'doctor', required: '', maxlength: '80', placeholder: 'Dr. Name' });
    const kind = el('select', { name: 'specialty' });
    kind.append(new Option('Kind of doctor (optional)', ''), ...KINDS.map((k) => new Option(k, k)));
    page.replaceChildren(
      el('p', { class: 'note' }, 'Every doctor each person saw. Bookings made with DocSaathi appear here by themselves; add other visits yourself.'),
      filters(),
      section('Coming up', mine(data.upcoming).map((v) => visitCard(v, true)), 'No appointments coming up.'),
      section('Visited', mine(data.visits).map((v) => visitCard(v, false)), 'No visits saved yet.'),
      form(
        'Add a visit',
        [
          field('For', memberSelect()),
          field('Doctor', doctorInput),
          field('Kind of doctor', kind),
          field('Clinic or hospital', el('input', { name: 'clinic', maxlength: '120', placeholder: 'Optional' })),
          field('Date', el('input', { name: 'date', type: 'date', required: '', max: data.today, value: data.today })),
          field('Notes', el('input', { name: 'notes', maxlength: '300', placeholder: 'For example: come back after 3 months' })),
        ],
        (v) => send('/api/records/visits', 'POST', v),
      ),
      shareButton(),
    );
  }

  function renderMedicines(): void {
    const page = pages.medicines;
    if (!data) {
      page.replaceChildren(el('p', { class: 'note' }, 'Could not load the record. Please try again.'));
      return;
    }
    const doctors = [...new Set([...data.visits, ...data.upcoming].map((v) => v.doctor))];
    const list = el('datalist', { id: 'rec-doctors' });
    list.append(...doctors.map((d) => new Option(d)));
    const meds = mine(data.medicines);
    page.replaceChildren(
      el('p', { class: 'note rec-safety' }, 'Write what the doctor wrote, so you can show the next doctor. DocSaathi never suggests medicines or doses: always follow your doctor.'),
      filters(),
      section('Taking now', meds.filter((m) => m.current).map(medicineCard), 'No medicines saved.'),
      section('Finished', meds.filter((m) => !m.current).map(medicineCard), 'Nothing finished yet.'),
      form(
        'Add a medicine',
        [
          field('For', memberSelect()),
          field('Medicine name (as the doctor wrote it)', el('input', { name: 'name', required: '', maxlength: '80' })),
          field('How to take it', el('input', { name: 'howToTake', maxlength: '120', placeholder: 'For example: 1 tablet morning and night, after food' })),
          field('For how many days', el('input', { name: 'days', type: 'number', min: '1', max: '3650', placeholder: 'Leave empty if ongoing' })),
          field('Doctor', el('input', { name: 'doctor', maxlength: '80', list: 'rec-doctors', placeholder: 'Dr. Name' })),
          field('Started on', el('input', { name: 'startedOn', type: 'date', value: data.today })),
          list,
        ],
        (v) => send('/api/records/medicines', 'POST', v),
      ),
      shareButton(),
    );
  }

  function render(): void {
    if (shown === 'visits') renderVisits();
    if (shown === 'medicines') renderMedicines();
  }

  return {
    async open(kind: 'visits' | 'medicines'): Promise<void> {
      shown = kind;
      pages[kind].replaceChildren(el('p', { class: 'note' }, 'Loading…'));
      await load();
      render();
    },
    close(): void {
      shown = null;
    },
  };
}
