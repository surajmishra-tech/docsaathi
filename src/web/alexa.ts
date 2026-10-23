// Echo Show simulator: an MCP Apps host for DocSaathi.
// Voice in (Chrome speech recognition) -> /api/assistant (the "Alexa" brain, which calls DocSaathi's
// MCP tools) -> spoken reply + the tool's MCP App screen, rendered in a double-iframe sandbox.
import { AppBridge, getToolUiResourceUri, PostMessageTransport, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { flash, setMood, startFx } from './fx.js';
import { recordPages } from './records.js';

type Any = Record<string, any>;
interface AssistantReply {
  speech: string;
  kind: string;
  tool: { name: string; arguments: Record<string, unknown>; result: Any } | null;
  end?: boolean; // they said goodbye: stop listening
  lang?: 'en' | 'hi'; // the language of the answer, so the right voice reads it
  speaker?: string | null; // who is talking now (member id), or null when not known
}

// Who is talking, as shown in the "Speaking:" menu (a real Echo knows it from the voice).
let shownSpeaker: string | null = null;

const HOST_INFO = { name: 'DocSaathi Echo Show simulator', version: '0.1.0' };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const device = $('device');
const screenEl = $('screen');
const idleEl = $('screen-idle');
const idleTime = $('idle-time');
const captionEl = $('caption');
const transcript = $('transcript');
const micBtn = $<HTMLButtonElement>('mic');
const handsFreeBtn = $<HTMLButtonElement>('handsfree');
const askForm = $<HTMLFormElement>('ask');
const askInput = $<HTMLInputElement>('ask-input');
const statusEl = $('status');
const phoneEl = $('phone');
const phoneTitle = $('phone-title');
const phoneMsgs = $('phone-msgs');
const linkCard = $('link-card');

let sandboxPort = 3001;
let clockOffsetDays = 0;
let busy = false;
let linked = false; // is DocSaathi linked to this simulated Echo (OAuth account linking)?

// On this PC the screen uses the double-iframe sandbox on its own port. Through a tunnel (for example
// ngrok on a phone) that second port is not reachable, so the screen runs in one locked-down iframe
// with an opaque origin: its scripts run, but it cannot touch this page, its cookies or its storage.
const ON_THIS_PC = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
// Lets requests through ngrok's free-plan browser warning page.
const EXTRA_HEADERS: Record<string, string> = { 'ngrok-skip-browser-warning': '1' };

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: { ...EXTRA_HEADERS, ...((init.headers as Record<string, string> | undefined) ?? {}) } });
}

// ---------------------------------------------------------------------------
// Small UI helpers

function setState(state: 'idle' | 'listening' | 'thinking' | 'speaking'): void {
  device.dataset.state = state;
  setMood(state);
}

function addBubble(who: 'you' | 'alexa' | 'error', text: string, extraClass = ''): HTMLElement {
  transcript.querySelector('.hint')?.remove();
  const el = document.createElement('p');
  el.className = `bubble ${who === 'you' ? 'you' : ''} ${who === 'error' ? 'error' : ''} ${extraClass}`.trim();
  const label = document.createElement('span');
  label.className = 'who';
  label.textContent = who === 'you' ? 'You' : 'Alexa';
  el.append(label, document.createTextNode(text));
  transcript.append(el);
  transcript.scrollTop = transcript.scrollHeight;
  return el;
}

function setCaption(who: string, text: string): void {
  captionEl.replaceChildren();
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = `${who}: `;
  captionEl.append(w, document.createTextNode(text));
}

/** On phones, bring the Echo screen back into view after each answer (if the user scrolled down). */
function revealDevice(): void {
  if (!window.matchMedia('(max-width: 640px)').matches) return;
  const r = device.getBoundingClientRect();
  if (r.top < 0 || r.top > window.innerHeight * 0.4) device.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function istNow(): Date {
  return new Date(Date.now() + clockOffsetDays * 86_400_000);
}

function tickClock(): void {
  const d = istNow();
  idleTime.textContent = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

async function refreshStatus(): Promise<void> {
  try {
    const [h, family, link] = (await Promise.all([
      api('/api/health').then((r) => r.json()),
      api('/api/family').then((r) => r.json()),
      api('/alexa/link/status').then((r) => r.json()),
    ])) as [Any, Any, Any];
    linked = Boolean(link.linked);
    linkCard.hidden = linked;
    // DocSaathi's account link with this Echo: tap to link, or (when linked) to unlink.
    const account = document.createElement('button');
    account.type = 'button';
    account.id = 'account';
    account.className = linked ? 'pill' : 'pill link-needed';
    account.title = linked ? `Linked for the ${link.family} since ${new Date(link.since).toLocaleString('en-IN')}. Tap to unlink.` : 'Link DocSaathi to this Echo';
    if (linked) {
      account.innerHTML = 'DocSaathi: <b>Linked ✓</b>';
      account.addEventListener('click', () => void unlinkAccount());
    } else {
      account.textContent = 'Link account';
      account.addEventListener('click', openLinking);
    }
    sandboxPort = h.sandboxPort ?? sandboxPort;
    clockOffsetDays = h.clockOffsetDays ?? 0;
    serverVoice = String(h.voice ?? '').startsWith('Amazon Polly');
    const pills = [
      ['UHI', h.uhi ?? 'test network'],
      ['Google Maps', h.google ? 'on' : 'off'],
      ['Brain', h.brain ?? 'demo'],
      ['Voice', h.voice ?? 'browser voice'],
      ...(clockOffsetDays ? [['Demo clock', `+${clockOffsetDays} days`]] : []),
    ];
    // Where "near me" is. Tap it to use this device's location instead.
    const where = document.createElement('button');
    where.type = 'button';
    where.className = 'pill';
    where.id = 'where';
    where.title = 'Use my location';
    where.innerHTML = 'Near: <b></b>';
    where.querySelector('b')!.textContent = String(family.home ?? 'home');
    where.addEventListener('click', () => useMyLocation(true));
    // Still the demo address: ask the browser once where this device is, so "near me" is near them.
    if (family.homeSource === 'default' && !locationTried) useMyLocation(false);
    // The language Alexa answers in. Tap to switch, or say "Hindi mein bolo" / "speak in English".
    const hindi = family.replyLang === 'hi';
    const speaks = document.createElement('button');
    speaks.type = 'button';
    speaks.className = 'pill';
    speaks.id = 'speaks';
    speaks.title = 'Change the language Alexa answers in';
    speaks.innerHTML = 'Alexa speaks: <b></b>';
    speaks.querySelector('b')!.textContent = hindi ? 'हिंदी' : 'English';
    speaks.addEventListener('click', async () => {
      await api('/api/family/language', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: hindi ? 'en' : 'hi' }) });
      await refreshStatus();
    });
    // Who is talking. A real Echo recognises each family member's voice (Alexa voice ID); here you
    // pick it, or just say "main Papa hoon". "Not sure" = Alexa asks when someone says "me".
    shownSpeaker = family.speaker ?? null;
    const speaking = document.createElement('label');
    speaking.className = 'pill';
    speaking.id = 'speaking';
    speaking.title = 'Who is talking to Alexa. A real Echo knows this from the voice.';
    speaking.append('Speaking: ');
    const pick = document.createElement('select');
    pick.setAttribute('aria-label', 'Who is talking to Alexa');
    pick.append(new Option('Not sure', ''), ...((family.members ?? []) as Any[]).map((m) => new Option(m.label, m.id)));
    pick.value = shownSpeaker ?? '';
    pick.addEventListener('change', async () => {
      await api('/api/family/speaker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: pick.value || null }) });
      await refreshStatus();
    });
    speaking.append(pick);
    statusEl.replaceChildren(
      account,
      speaking,
      where,
      speaks,
      ...pills.map(([k, v]) => {
        const s = document.createElement('span');
        s.className = 'pill';
        s.innerHTML = `${k}: <b></b>`;
        s.querySelector('b')!.textContent = String(v);
        return s;
      }),
    );
    tickClock();
  } catch {
    statusEl.textContent = 'Server not reachable';
  }
}

// ---------------------------------------------------------------------------
// Account linking: like enabling a skill in the Alexa app. The sign-in page opens in its own window
// (DocSaathi's page: mobile number + family PIN) and tells this page when it is done.

function openLinking(): void {
  const win = window.open('/alexa/link/start', 'docsaathi-link', 'popup,width=480,height=780');
  if (!win) window.location.href = '/alexa/link/start'; // pop-ups blocked: go there and come back
}

async function unlinkAccount(): Promise<void> {
  if (!window.confirm('Unlink DocSaathi from this Echo? Alexa will not be able to book doctors until you link it again.')) return;
  await api('/alexa/link/unlink', { method: 'POST' });
  client = null; // the screen's MCP connection used the old link
  clearScreen();
  await refreshStatus();
  addBubble('alexa', '(DocSaathi was unlinked from this Echo.)');
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || (event.data as Any)?.type !== 'docsaathi-link') return;
  if (!(event.data as Any).ok) return;
  client = null;
  void refreshStatus();
  addBubble('alexa', 'DocSaathi is linked. Ask me to find a doctor.');
});

$('link-btn').addEventListener('click', openLinking);

// ---------------------------------------------------------------------------
// Location: "near me" should mean near whoever is using it. An Echo knows its address; here the
// browser's location stands in for it. (Saying "I live in Rohini, Delhi" works too.)

let locationTried = false;

function useMyLocation(asked: boolean): void {
  locationTried = true;
  if (!('geolocation' in navigator)) {
    if (asked) addBubble('error', 'This browser cannot share a location. You can say: “I live in Rohini, Delhi”.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const res = await api('/api/family/location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        });
        const data = (await res.json()) as { label?: string; changed?: boolean; error?: string };
        if (!res.ok) {
          if (asked) addBubble('error', data.error ?? 'Could not save the location.');
          return;
        }
        if (data.changed || asked) addBubble('alexa', `(Location: I’ll look for doctors near ${data.label}.)`);
        await refreshStatus();
      } catch {
        if (asked) addBubble('error', 'Could not save the location. Please try again.');
      }
    },
    () => {
      if (asked) addBubble('error', 'Location is blocked for this page. Allow it in the browser, or say: “I live in Rohini, Delhi”.');
    },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
  );
}

async function refreshPhone(): Promise<void> {
  try {
    const data = (await (await api('/api/family/messages')).json()) as { to: string; body: string; at: string }[];
    if (!data.length) return;
    phoneEl.hidden = false;
    phoneTitle.textContent = `${data[0].to.split(' (')[0]}’s phone`;
    phoneMsgs.replaceChildren(
      ...data.slice(0, 4).map((m) => {
        const el = document.createElement('div');
        el.className = 'sms';
        el.textContent = m.body;
        const t = document.createElement('time');
        t.textContent = new Date(m.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
        el.append(t);
        return el;
      }),
    );
  } catch {
    // phone preview is optional
  }
}

// ---------------------------------------------------------------------------
// Speech out: Amazon Polly's voice from the server when it is on (VOICE=polly), else the browser's own voices.

let serverVoice = false; // the server speaks with Amazon Polly (from /api/health)
let audio: HTMLAudioElement | null = null; // Polly's answer that is playing now

/** Stop whatever Alexa is saying, in either voice. */
function stopSpeaking(): void {
  window.speechSynthesis?.cancel();
  if (audio) {
    const a = audio;
    audio = null;
    a.pause();
  }
}

function isSpeaking(): boolean {
  return Boolean(window.speechSynthesis?.speaking) || Boolean(audio && !audio.paused && !audio.ended);
}

let voice: SpeechSynthesisVoice | undefined; // for English answers
let hindiVoice: SpeechSynthesisVoice | undefined; // for Hindi answers
function pickVoice(): void {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  voice = voices.find((v) => v.lang === 'en-IN') ?? voices.find((v) => v.lang.startsWith('en-GB')) ?? voices.find((v) => v.lang.startsWith('en'));
  hindiVoice = voices.find((v) => v.lang === 'hi-IN') ?? voices.find((v) => v.lang.startsWith('hi'));
}
if ('speechSynthesis' in window) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

// Each spoken answer gets a number, so an answer that was cut off (the user started talking,
// or a newer answer began) does not reopen the mic.
let speakSeq = 0;
// What Alexa is saying right now, and how far she has got: so "roko, book this" knows which
// doctor "this" is (the one she was reading out).
let saying: { text: string; lang: 'en' | 'hi'; startedAt: number; charIndex: number } | null = null;

function speak(text: string, lang: 'en' | 'hi' = 'en'): void {
  const seq = ++speakSeq;
  const finished = () => {
    if (seq !== speakSeq) return;
    speakSeq++;
    saying = null;
    setState('idle');
    // If the stop-word listener was open, give the mic a moment before it opens again for the answer.
    if (stopBargeIn()) window.setTimeout(afterAlexaSpoke, 200);
    else afterAlexaSpoke();
  };
  stopSpeaking();
  saying = { text, lang, startedAt: Date.now(), charIndex: 0 };
  if (serverVoice) speakWithPolly(text, lang, seq, finished);
  else speakInBrowser(text, lang, seq, finished);
}

/** Polly's voice: the server sends the answer as an MP3. If that fails or is slow, the browser voice speaks. */
function speakWithPolly(text: string, lang: 'en' | 'hi', seq: number, finished: () => void): void {
  const fallback = () => {
    if (seq === speakSeq) speakInBrowser(text, lang, seq, finished);
  };
  const slow = new AbortController();
  const timer = window.setTimeout(() => slow.abort(), 6000);
  api('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang }), signal: slow.signal })
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`voice ${res.status}`))))
    .then((blob) => {
      if (seq !== speakSeq) return; // cut off while it was loading
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audio = a;
      let over = false;
      let started = false;
      const done = () => {
        if (over) return;
        over = true;
        URL.revokeObjectURL(url);
        if (audio === a) audio = null;
        finished(); // (does nothing if a newer answer or the person cut her off)
      };
      // The browser would not play it (nothing on the page was tapped yet, or a broken file): the browser voice says it.
      const giveUp = () => {
        if (over) return;
        over = true;
        URL.revokeObjectURL(url);
        if (audio === a) audio = null;
        fallback();
      };
      a.onplaying = () => {
        started = true;
        setState('speaking');
        if (saying && seq === speakSeq) saying.startedAt = Date.now();
      };
      // How far she is in the text (for "roko, book this"): the share of the audio played so far.
      a.ontimeupdate = () => {
        if (saying && seq === speakSeq && a.duration > 0) saying.charIndex = Math.round((text.length * a.currentTime) / a.duration);
      };
      a.onended = done;
      a.onerror = () => (started ? done() : giveUp());
      a.onpause = () => {
        if (audio !== a) done(); // stopped by stopSpeaking()
      };
      // In case the end is never reported, with a generous limit.
      a.onloadedmetadata = () => {
        if (Number.isFinite(a.duration)) window.setTimeout(() => seq === speakSeq && done(), a.duration * 1000 + 2500);
      };
      a.play().then(
        () => startBargeIn(text, seq), // in a hands-free conversation: "roko" / "stop" interrupts her
        giveUp,
      );
    })
    .catch(fallback)
    .finally(() => window.clearTimeout(timer));
}

function speakInBrowser(text: string, lang: 'en' | 'hi', seq: number, finished: () => void): void {
  if (!('speechSynthesis' in window)) {
    finished();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const chosen = lang === 'hi' ? hindiVoice : voice;
  if (chosen) {
    u.voice = chosen;
    u.lang = chosen.lang;
  } else {
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN'; // no such voice listed: let the browser pick one for the language
  }
  u.onstart = () => {
    setState('speaking');
    if (saying && seq === speakSeq) saying.startedAt = Date.now();
  };
  u.onboundary = (e) => {
    if (saying && seq === speakSeq) saying.charIndex = e.charIndex;
  };
  u.onend = finished;
  u.onerror = finished;
  window.speechSynthesis.speak(u);
  startBargeIn(text, seq); // in a hands-free conversation: "roko" / "stop" interrupts her
  // Chrome sometimes never reports the end of a long answer: watch for it, with a generous limit.
  const began = Date.now();
  const limit = 6000 + text.length * 120;
  const watch = window.setInterval(() => {
    const waited = Date.now() - began;
    const quiet = !window.speechSynthesis.speaking && !window.speechSynthesis.pending;
    if (seq !== speakSeq || (quiet && waited > 1500) || waited > limit) {
      window.clearInterval(watch);
      finished();
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// Speech in (Chrome / Edge)

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
const SpeechRecognitionCtor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
  .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

let listenLang = 'en-IN';
let recognition: Recognition | null = null;
let interimBubble: HTMLElement | null = null;

// Hands-free: like a real Echo in a conversation, the mic opens again by itself after Alexa
// answers. It closes after a few quiet rounds, on "bye", or when the mic button is tapped.
const HANDS_FREE_KEY = 'docsaathi.handsFree';
const QUIET_ROUNDS = 3;
let handsFree = true;
try {
  handsFree = window.localStorage.getItem(HANDS_FREE_KEY) !== '0';
} catch {
  // storage can be blocked; hands-free just stays on for this visit
}
let talking = false; // a voice conversation is going on (started with the mic)
let quietRounds = 0;
let listenAfterReply = false;

const isListening = () => micBtn.getAttribute('aria-pressed') === 'true';

function setListening(on: boolean): void {
  micBtn.setAttribute('aria-pressed', String(on));
  if (on) setState('listening');
  else if (device.dataset.state === 'listening') setState('idle');
}

/** `auto` = the mic opened by itself (hands-free), so problems stay quiet instead of showing errors. */
function startListening(auto = false, secondTry = false): void {
  if (!SpeechRecognitionCtor) {
    if (!auto) addBubble('error', 'Voice input needs Google Chrome or Microsoft Edge. You can type instead.');
    return;
  }
  if (isListening()) return;
  speakSeq++; // Alexa stops talking when you start
  saying = null;
  stopBargeIn();
  stopSpeaking();
  let heard = false;
  const rec = new SpeechRecognitionCtor();
  recognition = rec;
  rec.lang = listenLang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) {
      interimBubble ??= addBubble('you', '', 'interim');
      interimBubble.lastChild!.textContent = interim;
      setCaption('You', interim);
    }
    if (final.trim()) {
      heard = true;
      quietRounds = 0;
      interimBubble?.remove();
      interimBubble = null;
      rec.stop();
      void ask(final.trim());
    }
  };
  rec.onerror = (e) => {
    interimBubble?.remove();
    interimBubble = null;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      talking = false;
      if (!auto) addBubble('error', 'Please allow the microphone in Chrome (click the camera/mic icon in the address bar).');
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      talking = false;
      if (!auto) addBubble('error', `Voice error: ${e.error}`);
    }
  };
  rec.onend = () => {
    if (recognition !== rec) return;
    setListening(false);
    // Nothing was said: keep listening for a few rounds, then rest until the mic is tapped.
    if (heard || busy || !handsFree || !talking) return;
    if (++quietRounds < QUIET_ROUNDS) {
      startListening(true);
    } else {
      talking = false;
      quietRounds = 0;
      setCaption('Alexa', 'Tap the mic when you want to talk again.');
    }
  };
  try {
    rec.start();
    setListening(true);
  } catch {
    recognition = null;
    // The mic was still closing from a moment ago: try once more, then give up quietly.
    if (auto && !secondTry) window.setTimeout(() => startListening(true, true), 350);
    else talking = false;
  }
}

function stopListening(): void {
  const rec = recognition;
  recognition = null; // its onend will not reopen the mic
  setListening(false);
  try {
    rec?.stop();
  } catch {
    // already stopped
  }
  interimBubble?.remove();
  interimBubble = null;
}

/** Alexa finished an answer: in a hands-free conversation, listen for what they say next. */
function afterAlexaSpoke(): void {
  if (!handsFree || !talking) return;
  if (busy) listenAfterReply = true;
  else startListening(true);
}

// ---------------------------------------------------------------------------
// Interrupting Alexa by voice ("barge-in"). While she is talking in a hands-free conversation, a
// second listener waits only for a stop word: "roko", "ruko", "stop", "bas", "suno"...
// "Roko" alone makes her stop and listen. "Roko, book this" also does what comes after it, and
// "this" means the doctor she was reading out at that moment.

const STOP_WORDS = ['roko', 'ruko', 'rukiye', 'ruk jao', 'ruk', 'stop', 'bas', 'ek minute', 'wait', 'suno', 'रुकिए', 'रुको', 'रोको', 'रुक', 'स्टॉप', 'बस', 'सुनो'];
const THIS_ONE = /\b(this|that|yeh|ye|yahi|yehi|isko|isse|isi|isse hi|is wale|isko hi)\b|यह|यही|इसको|इसे/i;
const BOOK_NOW = /\b(book|pakka|fix|le lo|kar do|kardo|karo|kar dijiye)\b|बुक|पक्का|कर दो/i;
let barge: Recognition | null = null;
let bargeBroken = false; // this browser cannot listen while it speaks: fall back to tapping the mic

/** Where a stop word starts in what was heard (whole words only for Latin script), or -1. */
function findStopWord(heard: string, words: string[]): { at: number; word: string } | null {
  let best: { at: number; word: string } | null = null;
  for (const word of words) {
    const at = /^[a-z ]+$/.test(word) ? heard.search(new RegExp(`(^|[^a-z])${word}([^a-z]|$)`)) : heard.indexOf(word);
    if (at >= 0 && (!best || at < best.at)) best = { at: heard[at] === word[0] ? at : at + 1, word };
  }
  return best;
}

/** Which numbered doctor ("1: Dr. ...", "2: Dr. ...") Alexa was reading out just now. */
function numberBeingSaid(): number | undefined {
  if (!saying) return undefined;
  // Not every voice reports its position: estimate it from the time instead.
  const at = saying.charIndex > 0 ? saying.charIndex : Math.round((Date.now() - saying.startedAt) / (saying.lang === 'hi' ? 95 : 72));
  const marks = [...saying.text.slice(0, at + 2).matchAll(/(?:^|[\s.।])([1-9]): /g)];
  return marks.length ? Number(marks[marks.length - 1][1]) : undefined;
}

/** Close the stop-word listener. Says whether one was open (the mic then needs a moment before reopening). */
function stopBargeIn(): boolean {
  const rec = barge;
  barge = null;
  try {
    rec?.abort();
  } catch {
    // already stopped
  }
  return rec !== null;
}

// Phones play a sound and may cut the voice when the mic opens, so there you tap the mic to interrupt.
const ON_PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function startBargeIn(spokenText: string, seq: number): void {
  if (!handsFree || !talking || bargeBroken || ON_PHONE || !SpeechRecognitionCtor || isListening()) return;
  stopBargeIn();
  // Never react to a word Alexa herself is saying (the mic hears her too).
  const herWords = spokenText.toLowerCase();
  const stops = STOP_WORDS.filter((w) => !herWords.includes(w));
  const rec = new SpeechRecognitionCtor();
  barge = rec;
  rec.lang = listenLang;
  rec.interimResults = true;
  rec.continuous = true;
  let cut: { pointing: number | undefined } | null = null; // set once a stop word was heard
  rec.onresult = (e) => {
    if (barge !== rec) return;
    let heard = '';
    let final = true;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      heard += ` ${e.results[i][0].transcript}`;
      final &&= e.results[i].isFinal;
    }
    heard = heard.toLowerCase();
    const stop = findStopWord(heard, stops);
    if (!stop) return;
    if (!cut) {
      // Stop talking at once; keep this listener open to catch the rest of the sentence.
      cut = { pointing: numberBeingSaid() };
      if (seq === speakSeq) speakSeq++;
      saying = null;
      stopSpeaking();
      setState('listening');
      setCaption('You', '…');
    }
    if (!final) return;
    const rest = heard
      .slice(stop.at + stop.word.length)
      .replace(/^[\s,.!?।]+/, '')
      .trim();
    const pointing = cut.pointing;
    stopBargeIn();
    quietRounds = 0;
    if (rest.split(/\s+/).filter(Boolean).length === 0) {
      window.setTimeout(() => startListening(true), 150); // just "roko": now listen properly
      return;
    }
    // "book this" -> the doctor she was reading out, and (when they say book) the earliest time.
    const meansThat = pointing !== undefined && THIS_ONE.test(rest) && !/\d/.test(rest);
    void ask(meansThat ? `${rest} (doctor ${pointing}${BOOK_NOW.test(rest) ? ', earliest time' : ''})` : rest);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') bargeBroken = true;
  };
  rec.onend = () => {
    if (barge !== rec) return;
    if (cut) {
      // She was stopped but nothing more was caught: listen in the normal way.
      barge = null;
      window.setTimeout(() => startListening(true), 150);
    } else if (seq === speakSeq && isSpeaking() && !bargeBroken) {
      try {
        rec.start(); // the browser closed the listener while she is still talking: open it again
      } catch {
        barge = null;
      }
    } else {
      barge = null;
    }
  };
  try {
    rec.start();
  } catch {
    barge = null;
    bargeBroken = true;
  }
}

micBtn.addEventListener('click', () => {
  if (isListening()) {
    talking = false;
    stopListening();
  } else {
    talking = true;
    quietRounds = 0;
    startListening();
  }
});

function showHandsFree(): void {
  handsFreeBtn.setAttribute('aria-pressed', String(handsFree));
  handsFreeBtn.textContent = handsFree ? 'Hands-free: on' : 'Hands-free: off';
}
handsFreeBtn.addEventListener('click', () => {
  handsFree = !handsFree;
  try {
    window.localStorage.setItem(HANDS_FREE_KEY, handsFree ? '1' : '0');
  } catch {
    // not saved; fine
  }
  showHandsFree();
});
showHandsFree();

document.querySelectorAll<HTMLButtonElement>('.lang button').forEach((btn) =>
  btn.addEventListener('click', () => {
    listenLang = btn.dataset.lang ?? 'en-IN';
    document.querySelectorAll<HTMLButtonElement>('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  }),
);

// ---------------------------------------------------------------------------
// MCP: the browser connects to DocSaathi's MCP server to read the screen (ui://) resource,
// exactly like an MCP Apps host (Alexa+, Claude, ...) would.

let client: Client | null = null;
const tools = new Map<string, Any>();
const uiCache = new Map<string, { html: string; csp?: Any; permissions?: Any }>();

async function mcp(): Promise<Client> {
  if (client) return client;
  // The page speaks the newest MCP revision (2026-07-28); the Alexa brain on the server speaks 2025-11-25.
  const c = new Client(HOST_INFO, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  // Through "Alexa" (/alexa/mcp), which adds the family's OAuth token: the page never holds a token.
  await c.connect(new StreamableHTTPClientTransport(new URL('/alexa/mcp', window.location.origin), { requestInit: { headers: EXTRA_HEADERS } }));
  const list = await c.listTools();
  for (const t of list.tools) tools.set(t.name, t);
  client = c;
  return c;
}

async function uiResource(uri: string) {
  const cached = uiCache.get(uri);
  if (cached) return cached;
  const res = await (await mcp()).readResource({ uri });
  const content = res.contents[0] as Any;
  if (content?.mimeType !== RESOURCE_MIME_TYPE) throw new Error(`Unexpected screen type: ${content?.mimeType}`);
  const html = 'blob' in content ? atob(content.blob) : (content.text as string);
  const meta = content._meta?.ui ?? {};
  const value = { html, csp: meta.csp, permissions: meta.permissions };
  uiCache.set(uri, value);
  return value;
}

let bridge: AppBridge | null = null;
let frame: HTMLIFrameElement | null = null;
let renderSeq = 0;

function waitForSandbox(target: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source === target.contentWindow && (event.data as Any)?.method === 'ui/notifications/sandbox-proxy-ready') {
        window.removeEventListener('message', onMessage);
        resolve();
      }
    };
    window.addEventListener('message', onMessage);
  });
}

async function showScreen(name: string, args: Record<string, unknown>, result: Any): Promise<void> {
  const seq = ++renderSeq;
  await mcp();
  const tool = tools.get(name);
  const uri = tool ? getToolUiResourceUri(tool) : undefined;
  if (!uri) return;
  const ui = await uiResource(uri);
  if (seq !== renderSeq) return;

  // Tear down the previous screen.
  const old = { bridge, frame };
  bridge = null;
  frame = null;
  if (old.bridge) {
    old.bridge.teardownResource({}).catch(() => undefined);
    old.bridge.close().catch(() => undefined);
  }

  const next = document.createElement('iframe');
  next.title = 'DocSaathi screen';
  next.style.opacity = '0';
  if (ON_THIS_PC) {
    next.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    screenEl.append(next);
    const ready = waitForSandbox(next);
    next.src = `http://${window.location.hostname}:${sandboxPort}/sandbox.html`;
    await ready;
  } else {
    next.setAttribute('sandbox', 'allow-scripts allow-forms');
    screenEl.append(next);
  }

  const rect = screenEl.getBoundingClientRect();
  const b = new AppBridge(
    client,
    HOST_INFO,
    { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
    {
      hostContext: {
        theme: 'dark',
        platform: 'web',
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        containerDimensions: { width: Math.round(rect.width), height: Math.round(rect.height) },
        locale: 'en-IN',
        timeZone: 'Asia/Kolkata',
      },
    },
  );
  // A tap on the screen ("Book it", a time, "More times") joins the conversation like speech.
  b.onmessage = async (params) => {
    const text = (params.content ?? [])
      .map((c: Any) => (c.type === 'text' ? c.text : ''))
      .join(' ')
      .trim();
    if (text) void ask(text);
    return {};
  };
  // The screen may open web links (Google Maps, Google Calendar, WhatsApp) and dial a clinic's number.
  b.onopenlink = async ({ url }) => {
    if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    else if (/^tel:\+?\d{5,15}$/.test(url)) window.location.href = url;
    return {};
  };
  b.onsizechange = () => undefined; // the Echo screen has a fixed size
  const initialized = new Promise<void>((resolve) => {
    b.oninitialized = () => resolve();
  });
  await b.connect(new PostMessageTransport(next.contentWindow!, next.contentWindow!));
  if (ON_THIS_PC) await b.sendSandboxResourceReady({ html: ui.html, csp: ui.csp, permissions: ui.permissions });
  else next.srcdoc = ui.html;
  await initialized;
  if (seq !== renderSeq) {
    b.close().catch(() => undefined);
    next.remove();
    return;
  }
  await b.sendToolInput({ arguments: args });
  await b.sendToolResult(result as Parameters<AppBridge['sendToolResult']>[0]);

  bridge = b;
  frame = next;
  next.style.opacity = '1';
  idleEl.hidden = true;
  old.frame?.remove();
}

/** Back to the clock (and the "Link account" card when DocSaathi is not linked). */
function clearScreen(): void {
  renderSeq++;
  bridge?.close().catch(() => undefined);
  bridge = null;
  frame = null;
  screenEl.querySelectorAll('iframe').forEach((f) => f.remove());
  idleEl.hidden = false;
}

// ---------------------------------------------------------------------------
// The conversation

async function ask(text: string): Promise<void> {
  if (!text || busy) return;
  busy = true;
  listenAfterReply = false;
  if (isListening()) stopListening();
  stopBargeIn();
  micBtn.disabled = true;
  addBubble('you', text);
  setCaption('You', text);
  setState('thinking');
  try {
    const res = await api('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = (await res.json()) as AssistantReply;
    addBubble('alexa', reply.speech);
    setCaption('Alexa', reply.speech);
    if (reply.end) talking = false;
    speak(reply.speech, reply.lang);
    if (reply.tool) await showScreen(reply.tool.name, reply.tool.arguments, reply.tool.result);
    revealDevice();
    if (reply.kind === 'link-required') {
      clearScreen();
      await refreshStatus();
    }
    if (reply.kind === 'booked' || reply.kind === 'emergency') flash(reply.kind);
    if (reply.kind === 'booked') await refreshPhone();
    if (reply.kind === 'location' || reply.kind === 'language' || (reply.speaker ?? null) !== shownSpeaker) await refreshStatus();
  } catch (err) {
    setState('idle');
    addBubble('error', `Sorry, something went wrong (${err instanceof Error ? err.message : String(err)}). Please try again.`);
  } finally {
    busy = false;
    micBtn.disabled = false;
    // Alexa finished speaking while the screen was still loading: open the mic now.
    if (listenAfterReply) {
      listenAfterReply = false;
      startListening(true);
    }
  }
}

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = askInput.value.trim();
  askInput.value = '';
  void ask(text);
});

/** Everything back to the start: clock, conversation, test bookings and the screen. */
async function resetDemo(): Promise<void> {
  await api('/api/demo/reset', { method: 'POST' });
  talking = false;
  stopListening();
  stopBargeIn();
  saying = null;
  speakSeq++;
  stopSpeaking();
  clearScreen();
  transcript.replaceChildren();
  captionEl.replaceChildren();
  phoneEl.hidden = true;
  setState('idle');
  await refreshStatus();
  addBubble('alexa', '(Demo reset: clock back to today, test bookings cleared.)');
}

$('demo-lines')
  .parentElement!.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn) return;
    if (btn.dataset.line) {
      void ask(btn.dataset.line);
    } else if (btn.dataset.action === 'jump') {
      await api('/api/demo/time-jump', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 90 }) });
      await refreshStatus();
      addBubble('alexa', '(Demo: the clock jumped 3 months ahead.)');
    } else if (btn.dataset.action === 'reset') {
      await resetDemo();
    }
  });

// ---------------------------------------------------------------------------
// The menu (☰): everything DocSaathi can do, one tap away. Most buttons say a sentence to Alexa,
// so they work exactly like speaking.

const menuBtn = $<HTMLButtonElement>('menu-btn');
const drawer = $('drawer');
const scrim = $('drawer-scrim');
const drawerBody = drawer.querySelector<HTMLElement>('.drawer-body')!;
const drawerTitle = $('drawer-title');
const drawerBack = $<HTMLButtonElement>('drawer-back');
const pageEls = { visits: $('page-visits'), medicines: $('page-medicines') };
const records = recordPages(api, pageEls);
const PAGE_TITLES = { visits: 'Doctors we visited', medicines: 'Medicine records' } as const;

/** A page inside the menu (the health record), or back to the list of buttons. */
function showPage(kind: 'visits' | 'medicines' | null): void {
  drawerBody.hidden = kind !== null;
  pageEls.visits.hidden = kind !== 'visits';
  pageEls.medicines.hidden = kind !== 'medicines';
  drawerBack.hidden = kind === null;
  drawerTitle.textContent = kind ? PAGE_TITLES[kind] : 'DocSaathi menu';
  if (kind) {
    void records.open(kind);
    drawerBack.focus();
  } else {
    records.close();
  }
}
drawerBack.addEventListener('click', () => {
  showPage(null);
  $('drawer-close').focus();
});

function openMenu(): void {
  const link = $('menu-link');
  link.firstChild!.textContent = linked ? 'Unlink DocSaathi' : 'Link account';
  link.querySelector('small')!.textContent = linked ? 'Alexa stops booking for your family until you link again' : 'Sign in with the family mobile number and PIN';
  drawer.hidden = false;
  scrim.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add('open');
    scrim.classList.add('open');
  });
  menuBtn.setAttribute('aria-expanded', 'true');
  menuBtn.setAttribute('aria-label', 'Close menu');
  document.body.style.overflow = 'hidden';
  $('drawer-close').focus();
}

function closeMenu(): void {
  drawer.classList.remove('open');
  scrim.classList.remove('open');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-label', 'Open menu');
  document.body.style.overflow = '';
  window.setTimeout(() => {
    if (drawer.classList.contains('open')) return;
    drawer.hidden = true;
    scrim.hidden = true;
    showPage(null); // next time the menu opens on its list of buttons
  }, 260);
  menuBtn.focus();
}

menuBtn.addEventListener('click', () => (drawer.hidden ? openMenu() : closeMenu()));
scrim.addEventListener('click', closeMenu);
$('drawer-close').addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !drawer.hidden) closeMenu();
});
// Keyboard focus stays inside the open menu.
drawer.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const items = [...drawer.querySelectorAll<HTMLElement>('button, a[href], input, select, summary')].filter((i) => i.offsetParent !== null);
  const first = items[0];
  const lastItem = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    lastItem.focus();
  } else if (!e.shiftKey && document.activeElement === lastItem) {
    e.preventDefault();
    first.focus();
  }
});
drawer.addEventListener('click', async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-say], [data-action], [data-call], [data-page]');
  if (!el) return;
  if (el.dataset.page === 'visits' || el.dataset.page === 'medicines') {
    showPage(el.dataset.page);
    return;
  }
  if (el.dataset.call) {
    // Emergency numbers: never dialled by a slip of the finger.
    e.preventDefault();
    if (window.confirm(`Call ${el.dataset.call} now?`)) window.location.href = `tel:${el.dataset.call}`;
    return;
  }
  closeMenu();
  if (el.dataset.say) {
    void ask(el.dataset.say);
    return;
  }
  switch (el.dataset.action) {
    case 'link':
      if (linked) void unlinkAccount();
      else openLinking();
      break;
    case 'location':
      useMyLocation(true);
      break;
    case 'language':
      document.getElementById('speaks')?.click();
      break;
    case 'clinic':
      window.open('/clinic', '_blank', 'noopener');
      break;
    case 'reset':
      await resetDemo();
      break;
  }
});

// News from clinics (accepted a booking, or can't take it): Alexa says it by herself, when she is free.
let noticesBusy = false;
async function checkNotices(): Promise<void> {
  if (noticesBusy || busy || device.dataset.state === 'speaking' || device.dataset.state === 'thinking') return;
  noticesBusy = true;
  try {
    const news = (await (await api('/api/family/notices')).json()) as Array<{ speech: string; lang: 'en' | 'hi'; kind: string }>;
    if (!news.length) return;
    const speech = news.map((n) => n.speech).join(' ');
    if (isListening()) stopListening(); // she speaks; in a hands-free conversation the mic opens again after
    addBubble('alexa', speech, 'notice');
    setCaption('Alexa', speech);
    speak(speech, news[news.length - 1].lang);
    await refreshPhone();
  } catch {
    // try again next time
  } finally {
    noticesBusy = false;
  }
}
setInterval(() => void checkNotices(), 4000);

startFx($<HTMLCanvasElement>('fx-bg'), $<HTMLCanvasElement>('fx-hero'));
setState('idle');
// The screen connects to DocSaathi once it is linked (before that, Alexa's /alexa/mcp answers 401).
void refreshStatus().then(() => {
  if (linked) mcp().catch((err) => addBubble('error', `Could not reach DocSaathi’s MCP server: ${err instanceof Error ? err.message : err}`));
});
void refreshPhone();
setInterval(tickClock, 30_000);

// If this browser already allowed the mic and the location for this page, use them right away:
// the mic is open when the page loads, and "near me" is near this device. Nothing is asked here;
// the first mic tap or location tap is what asks for permission.
const allowed = (name: string) =>
  navigator.permissions
    ?.query({ name: name as PermissionName })
    .then((p) => p.state === 'granted')
    .catch(() => false) ?? Promise.resolve(false);
void allowed('microphone').then((ok) => {
  if (ok && handsFree && SpeechRecognitionCtor && !busy && !isListening()) {
    talking = true;
    startListening(true);
  }
});
void allowed('geolocation').then((ok) => {
  if (ok && !locationTried) useMyLocation(false);
});
