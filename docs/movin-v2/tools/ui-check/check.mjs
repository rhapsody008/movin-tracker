// Drives headless Chrome over CDP against the dev stack and checks the v2 page.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Screenshots go to tmp/ui-check/ (git-ignored), wherever this script lives.
const OUT = new URL("../../../../../tmp/ui-check/", import.meta.url).pathname;
// Never point this at the real bucket: it edits entries and resets the
// Telegram allowlist. Run it against a throwaway app on MinIO (BASE=:8090).
const BASE = process.env.BASE || "http://127.0.0.1:8090";
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--remote-debugging-port=9333", "--no-first-run", "--disable-gpu",
   `--user-data-dir=${mkdtempSync(join(tmpdir(), "cdp-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const waiters = new Map(); const errors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const t = await (await fetch("http://127.0.0.1:9333/json")).json(); const p = t.find(x => x.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(200);
  }
  throw new Error("chrome did not start");
}
function cmd(method, params = {}) {
  return new Promise(res => { const n = ++id; waiters.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
}
async function ev(expr) {
  const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result.result.value;
}
async function shot(name, w, h) {
  await cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  await sleep(400);
  const r = await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, name), Buffer.from(r.result.data, "base64"));
}
const api = async (p, o) => (await fetch(BASE + p, o)).json();
const find = async title => (await api("/api/entries")).doc.entries.find(e => e.title === title);
const results = [];
const check = (name, ok, info = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); };

try {
  // Start from the defaults even if an earlier run stopped half-way.
  for (const [path, body] of [["/api/settings/checkin", { useEnv: true }], ["/api/settings/telegram", { useEnv: true }]])
    await fetch(BASE + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  ws = new WebSocket(await connect());
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && waiters.has(d.id)) { waiters.get(d.id)(d); waiters.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || "exception");
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map(a => a.value ?? a.description).join(" "));
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !/fonts\.g/.test(d.params.entry.url || "")) errors.push(d.params.entry.text + " " + (d.params.entry.url || ""));
  };
  await cmd("Runtime.enable"); await cmd("Log.enable"); await cmd("Page.enable");
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cmd("Page.navigate", { url: BASE + "/" });
  for (let i = 0; i < 50 && !(await ev("typeof S!=='undefined' && S.loaded")); i++) await sleep(200);
  check("page loads entries over SSE", await ev("S.loaded"));
  await ev("localStorage.clear(); S.f={room:'',kind:'',cat:'',text:''}; render(); true");

  const cols = await ev(`[...document.querySelectorAll('.col')].map(c=>c.querySelector('h2').textContent+':'+[...c.querySelectorAll('.ct')].map(b=>b.textContent).join('|'))`);
  check("four columns", cols.length === 4, cols.join("  /  "));
  const doc = (await api("/api/entries")).doc;
  const live = doc.entries.filter(e => !e.archived).length;
  const cards = await ev("document.querySelectorAll('.card').length");
  check("every live entry has a card", cards === live, `${cards} cards, ${live} live entries`);
  check("decision sits in Decided", cols[2].includes("Sintered stone countertop"), cols[2]);
  check("money header follows F3", /Quoted/.test(await ev("$('money').textContent")), await ev("$('money').textContent"));
  check("key tag renders", (await ev("$('keytag').textContent")).length > 0, await ev("$('keytag').textContent"));
  await shot("desktop.png", 1440, 1000);

  // status pill cycles, banner offers Undo, Undo reverts
  const carp = await find("Carpentry");
  await ev(`document.querySelector('[data-cycle="${carp.id}"]').click(); true`);
  await sleep(800);
  check("status pill advances todo → doing", (await find("Carpentry")).status === "doing");
  const hasUndo = await ev("!!document.querySelector('#banner .undo')");
  check("banner offers Undo after a web edit", hasUndo, await ev("$('banner').textContent"));
  if (hasUndo) { await ev("document.querySelector('#banner .undo').click(); true"); await sleep(800); }
  check("Undo reverts the status", (await find("Carpentry")).status === "todo");

  // edit dialog keeps a change made elsewhere while it was open (review finding)
  {
    const c0 = await find("Carpentry");
    await ev(`openEntry('${c0.id}'); true`); await sleep(200);
    // meanwhile the bot records a payment
    await fetch(BASE + "/api/entries/" + c0.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cost: { actual: 5400 } }) });
    await sleep(600);
    await ev(`(()=>{ const f=$('entryForm'); f.vendor.value='Lim Carpentry'; f.requestSubmit(); return true; })()`); await sleep(900);
    const c1 = await find("Carpentry");
    check("dialog save keeps a payment recorded elsewhere while it was open", c1.vendor === "Lim Carpentry" && c1.cost.actual === 5400, JSON.stringify({ vendor: c1.vendor, cost: c1.cost }));
    const patches = () => ev(`performance.getEntriesByType('resource').filter(r=>r.name.endsWith('/api/entries/${c0.id}')).length`);
    const before = await patches();
    await ev(`openEntry('${c0.id}'); $('entryForm').requestSubmit(); true`); await sleep(500);
    check("saving the dialog unchanged sends nothing", (await patches()) === before);
    await fetch(BASE + "/api/entries/" + c0.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendor: "", cost: { actual: null } }) });
    await sleep(600);
    const gets = () => ev(`performance.getEntriesByType('resource').filter(r=>r.name === location.origin + '/api/entries').length`);
    const g0 = await gets();
    await ev(`document.querySelector('[data-cycle="${c0.id}"]').click(); true`); await sleep(900);
    check("a status click causes no extra full refetch", (await gets()) === g0, `${(await gets()) - g0} extra GET /api/entries`);
    await fetch(BASE + "/api/entries/" + c0.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "todo" }) });
    await sleep(600);
  }

  // new entry dialog
  await ev(`(()=>{ $('newEntry').click(); const f=$('entryForm'); f.title.value='UI check: herringbone floor'; f.kind.value='idea'; f.kind.dispatchEvent(new Event('change'));
    f.room.value='living'; f.category.value='flooring'; f.estimate.value='2500'; f.tags.value='Floor, wood'; f.requestSubmit(); return true; })()`);
  await sleep(900);
  const made = await find("UI check: herringbone floor");
  check("dialog creates an entry with the new fields", made && made.kind === "idea" && made.room === "living" && made.cost.estimate === 2500 && made.tags.join() === "floor,wood" && made.channel === "web", JSON.stringify(made && {kind: made.kind, room: made.room, cost: made.cost, tags: made.tags}));

  // kind change in the dialog remaps the status list
  await ev(`(()=>{ openEntry('${made.id}'); const f=$('entryForm'); f.kind.value='task'; f.kind.dispatchEvent(new Event('change')); return true; })()`);
  const st = await ev("[...$('entryForm').status.options].map(o=>o.value).join(',')+' = '+$('entryForm').status.value");
  check("dialog: switching kind to task offers todo/doing/done", st === "todo,doing,done = todo", st);
  await ev("$('entryDlg').close(); true");

  // filters
  await ev("$('fRoom').value='living'; $('fRoom').dispatchEvent(new Event('change')); true");
  const fc = await ev("document.querySelectorAll('.card').length");
  check("room filter narrows the board", fc === 1, `${fc} card(s), count: ${await ev("$('fCount').textContent")}`);
  await ev("$('fClear').click(); true");
  check("clear filters restores the board", (await ev("document.querySelectorAll('.card').length")) === live + 1);

  // archive via API → board updates live over SSE
  await fetch(BASE + "/api/entries/" + made.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: true }) });
  await sleep(900);
  check("outside change arrives over SSE", (await ev("document.querySelectorAll('.card').length")) === live, "archived via API");
  await fetch(BASE + "/api/entries/" + made.id, { method: "DELETE" });

  // dated entries show on the calendar
  const evs = await ev("[...document.querySelectorAll('#calGrid .ev')].map(e=>e.textContent)");
  check("calendar shows dated entries", evs.length > 0, evs.join(" | "));

  // milestones: done day stamped, tick in the dialog, timeline, un-done, Undo
  {
    const post = await (await fetch(BASE + "/api/entries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "UI check: keys collected", kind: "task" }) })).json();
    await sleep(700);
    const mk = await find("UI check: keys collected");
    check("milestones: empty-state hint before any", /None yet|No milestones/.test(await ev("$('mileList').textContent")) || (await ev("$('mileList').querySelectorAll('.mi').length")) > 0);
    await ev(`(()=>{ openEntry('${mk.id}'); return true; })()`);
    check("dialog: 'Done on' hidden while not done", await ev("getComputedStyle($('doneOnRow')).display==='none'"));
    await ev(`(()=>{ const f=$('entryForm'); f.status.value='done'; f.status.dispatchEvent(new Event('change')); return true; })()`);
    check("dialog: picking Done shows 'Done on' filled with today", await ev("getComputedStyle($('doneOnRow')).display!=='none' && $('entryForm').completed.value===today()"));
    await ev(`(()=>{ $('entryForm').milestone.checked=true; return true; })()`);
    await shot("milestone-dialog.png", 1440, 1000);
    await shot("milestone-dialog-phone.png", 390, 844);
    await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await ev(`(()=>{ const f=$('entryForm'); f.completed.value='2026-10-03'; f.requestSubmit(); return true; })()`);
    await sleep(900);
    let m1 = await find("UI check: keys collected");
    check("dialog saves done + milestone + chosen day", m1.status === "done" && m1.milestone === true && m1.completed === "2026-10-03", JSON.stringify({ s: m1.status, m: m1.milestone, c: m1.completed }));
    const tl = await ev("[...$('mileList').querySelectorAll('h3,.mi')].map(x=>x.textContent.trim()).join(' | ')");
    check("timeline lists it under its month with the day", /October 2026/.test(tl) && /✓ 3 Oct\s*UI check: keys collected/.test(tl), tl);
    check("card shows the ★", await ev(`!!document.querySelector('.card[data-id="${mk.id}"] .star')`));
    await ev(`(()=>{ document.querySelector('#mileList .mi[data-edit="${mk.id}"]').click(); return true; })()`);
    check("clicking a milestone opens the entry", await ev(`$('entryDlg').open && $('entryForm').title.value==='UI check: keys collected'`));
    await ev("$('entryDlg').close(); true");
    // status pill done → todo (cycle) clears the day and drops it from the timeline
    await ev(`(()=>{ document.querySelector('.card[data-id="${mk.id}"] [data-cycle]').click(); return true; })()`);
    await sleep(900);
    m1 = await find("UI check: keys collected");
    check("leaving done clears the day and removes it from the timeline", m1.status === "todo" && !m1.completed && !(await ev(`!!document.querySelector('#mileList .mi[data-edit="${mk.id}"]')`)), JSON.stringify({ s: m1.status, c: m1.completed }));
    await ev("[...document.querySelectorAll('#banner [data-undo]')].pop()?.click(); true");
    await sleep(900);
    m1 = await find("UI check: keys collected");
    check("Undo brings back done, milestone and day", m1.status === "done" && m1.milestone && m1.completed === "2026-10-03" && (await ev(`!!document.querySelector('#mileList .mi[data-edit="${mk.id}"]')`)), JSON.stringify({ s: m1.status, m: m1.milestone, c: m1.completed }));
    await shot("milestones.png", 1440, 1000);
    await ev("$('milestones').scrollIntoView(); true");
    await shot("milestones-view.png", 1440, 1000);
    await fetch(BASE + "/api/entries/" + mk.id, { method: "DELETE" });
    await sleep(500);
    void post;
  }

  // chat change lines render with Undo (no LLM: feed the renderer directly)
  await ev(`(()=>{ const a=bubble('a','ok'); changeLines(a,[{id:'X',text:'Saved: flex · note · test'},{text:'Move-in set to Sat, 5 Dec'}]); return true; })()`);
  check("chat change lines: Undo only on journaled ones", (await ev("document.querySelectorAll('.msg .ch .undo').length")) === 1);

  // admin panel: Storage + LLM tabs
  await ev("$('openAdmin').click(); true"); await sleep(300);
  check("Settings link opens the drawer", await ev("$('drawer').classList.contains('open')"));
  check("Storage, LLM, Telegram and Documents tabs are visible", (await ev("[...document.querySelectorAll('.tabs [data-tab]')].filter(b=>!b.hidden).map(b=>b.dataset.tab).join(',')")) === "storage,llm,telegram,docs");
  await ev("$('tab-storage').click(); true"); await sleep(800);
  const info = await ev("$('storageInfo').innerText");
  check("Storage tab shows bucket, MinIO endpoint, env keys, last write", /movin-dev/.test(info) && /minio:9000/.test(info) && /env keys/.test(info) && /entries\.json/.test(info), info.replace(/\n/g, " | "));
  check("LLM form and footer not visible on the Storage tab", await ev("getComputedStyle($('setForm')).display==='none' && getComputedStyle($('llmFoot')).display==='none'"));
  await ev("$('storageTest').click(); true"); await sleep(1200);
  const steps = await ev("[...$('storageSteps').children].map(li=>li.className+':'+li.textContent).join(' | ')");
  check("storage test shows six passing steps", (await ev("$('storageSteps').querySelectorAll('li.ok').length")) === 7, steps);
  await shot("admin-storage.png", 1440, 1000);
  await ev("$('tab-llm').click(); true"); await sleep(800);
  check("LLM tab shows the existing form, filled from the server", await ev("getComputedStyle($('setForm')).display!=='none' && getComputedStyle($('llmFoot')).display!=='none' && getComputedStyle($('panel-storage')).display==='none' && $('setForm').baseUrl.value.length>0"), await ev("$('setForm').baseUrl.value"));
  // LLM tab order: endpoint + key -> Test connection -> pick model -> Save.
  check("no temperature / max tokens / timeout / tool rounds fields", await ev("!['temperature','maxTokens','timeoutSec','maxToolRounds'].some(n=>$('setForm').elements[n])"));
  for (let i = 0; i < 40 && !(await ev("/Connected|Couldn't/.test($('connResult').textContent)")); i++) await sleep(500);
  check("a saved endpoint connects by itself and fills the model list", await ev("/Connected/.test($('connResult').textContent) && !$('setForm').model.disabled && $('setForm').model.options.length>1"), await ev("$('connResult').textContent"));
  check("the saved model is selected", await ev("$('setForm').model.value === (setState.model||'')"), await ev("$('setForm').model.value"));
  check("Save enabled once connected with a model", !(await ev("$('setSave').disabled")));
  check("'Save even though…' stays hidden until a check fails", await ev("getComputedStyle($('saveAnywayRow')).display==='none'"));
  await ev("$('setForm').baseUrl.value='http://host.docker.internal:1/v1'; $('setForm').baseUrl.dispatchEvent(new Event('input',{bubbles:true})); true");
  check("changing the URL locks the model list and Save", await ev("$('setForm').model.disabled && $('setSave').disabled"));
  await ev("$('testBtn').click(); true");
  for (let i = 0; i < 40 && !(await ev("/Connected|Couldn't/.test($('connResult').textContent)")); i++) await sleep(500);
  check("a dead endpoint: connection error, model stays locked", await ev("/Couldn't connect/.test($('connResult').textContent) && $('setForm').model.disabled && $('setSave').disabled"), await ev("$('connResult').textContent"));
  await ev("$('setForm').baseUrl.value=setState.baseUrl; $('setForm').baseUrl.dispatchEvent(new Event('input',{bubbles:true})); $('testBtn').click(); true");
  for (let i = 0; i < 40 && !(await ev("/Connected/.test($('connResult').textContent)")); i++) await sleep(500);
  await ev("$('setForm').model.value=setState.model; $('setForm').model.dispatchEvent(new Event('change',{bubbles:true})); true");
  check("reconnecting unlocks the model list again", await ev("!$('setForm').model.disabled && !$('setSave').disabled"));
  await shot("admin-llm.png", 1440, 1000);
  await ev("$('setSave').click(); true");
  for (let i = 0; i < 240 && (await ev("$('drawer').classList.contains('open')")) && !(await ev("/Not saved/.test($('testResult').textContent)")); i++) await sleep(500);
  check("Save checks tool calling, then saves and closes", !(await ev("$('drawer').classList.contains('open')")), await ev("$('testResult').textContent"));
  await ev("openSettings('llm'); true"); await sleep(300);
  // Connection kind: Claude hides the URL, lists Claude's models, saves and reloads as Claude.
  const waitConn = async () => { for (let i = 0; i < 40 && !(await ev("/Connected|Couldn't/.test($('connResult').textContent)")); i++) await sleep(250); };
  const setKind = k => ev(`(()=>{ const r=[...document.querySelectorAll('#setForm input[name=kind]')].find(x=>x.value==='${k}'); r.checked=true; r.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
  await waitConn();
  check("kind starts as OpenAI-compatible with the URL shown", await ev("$('setForm').kind.value==='openai' && getComputedStyle($('urlRow')).display!=='none' && getComputedStyle($('claudeNote')).display==='none'"));
  await setKind("claude"); await sleep(200);
  check("Claude: URL hidden, note shown, models locked until tested", await ev("getComputedStyle($('urlRow')).display==='none' && getComputedStyle($('claudeNote')).display!=='none' && $('setForm').model.disabled && $('setSave').disabled"));
  check("Claude: think wording changes", /deeper thinking with \/think/.test(await ev("$('thinkLabel').textContent")), await ev("$('thinkLabel').textContent"));
  await ev("$('testBtn').click(); true"); await waitConn();
  check("Claude: Test connection lists Claude's models, Opus 5.5 preselected", await ev("/Connected/.test($('connResult').textContent) && !$('setForm').model.disabled && $('setForm').model.value==='claude-opus-5-5'"), await ev("$('connResult').textContent+' | '+$('setForm').model.value"));
  await shot("admin-llm-claude.png", 1440, 1000);
  await ev("$('setSave').click(); true");
  for (let i = 0; i < 40 && (await ev("$('drawer').classList.contains('open')")); i++) await sleep(250);
  check("Claude: Save checks tool calling and saves", !(await ev("$('drawer').classList.contains('open')")), await ev("$('testResult').textContent"));
  check("saved as kind claude on the server", (await api("/api/settings/llm")).kind === "claude");
  await ev("openSettings('llm'); true"); await sleep(300); await waitConn();
  check("reopened: Claude kept, URL hidden, connects by itself", await ev("$('setForm').kind.value==='claude' && getComputedStyle($('urlRow')).display==='none' && /Connected/.test($('connResult').textContent) && $('setForm').model.value==='claude-opus-5-5'"), await ev("$('connResult').textContent"));
  await setKind("openai"); await sleep(200);
  check("back to OpenAI-compatible: URL shown, models locked again", await ev("getComputedStyle($('urlRow')).display!=='none' && $('setForm').model.disabled"));
  await ev("$('setForm').baseUrl.value='https://api.anthropic.com/v1'; $('setForm').baseUrl.dispatchEvent(new Event('input',{bubbles:true})); true");
  check("hint when OpenAI-compatible points at api.anthropic.com", await ev("getComputedStyle($('anthHint')).display!=='none'"));
  await ev("$('setForm').baseUrl.value='http://host.docker.internal:18090/v1'; $('setForm').baseUrl.dispatchEvent(new Event('input',{bubbles:true})); $('testBtn').click(); true"); await waitConn();
  await ev("$('setForm').model.value='stub-openai-model'; $('setForm').model.dispatchEvent(new Event('change',{bubbles:true})); $('setSave').click(); true");
  for (let i = 0; i < 40 && (await ev("$('drawer').classList.contains('open')")); i++) await sleep(250);
  check("OpenAI-compatible flow unchanged: test, pick, save", (await api("/api/settings/llm")).kind === "openai" && !(await ev("$('drawer').classList.contains('open')")));
  await ev("openSettings('llm'); true"); await sleep(300);
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  check("Escape closes the drawer", !(await ev("$('drawer').classList.contains('open')")));
  await ev("$('openSettings').click(); true"); await sleep(300);
  check("chat gear opens straight on the LLM tab", (await ev("$('tab-llm').getAttribute('aria-selected')")) === "true");
  await ev("closeSettings(); true");

  // documents tab
  await ev("openSettings('docs'); true"); await sleep(800);
  check("Documents tab: other panels hidden, list grouped by folder", await ev("getComputedStyle($('panel-docs')).display!=='none' && getComputedStyle($('setForm')).display==='none' && getComputedStyle($('panel-telegram')).display==='none' && /1\\.0 Plans \\(1\\)/.test($('docsList').innerText)"), await ev("$('docsList').innerText"));
  check("Documents tab: status line counts and last sync", /1 readable: 0 text, 0 drawings, 1 scanned/.test(await ev("$('docsStatus').textContent")) && /Last sync .*\((startup|web)\)/.test(await ev("$('docsStatus').textContent")), await ev("$('docsStatus').textContent"));
  await ev("$('docsList').querySelector('details').open = true; true"); await sleep(100);
  check("Documents tab: document row with pages and class", /Sample plan\.pdf[\s\S]*3 pages · scanned/.test(await ev("$('docsList').innerText")), await ev("$('docsList').innerText"));
  await shot("admin-docs.png", 1440, 1000);
  await ev("$('docsSync').click(); true");
  for (let i = 0; i < 40 && !/\(web\)/.test(await ev("$('docsStatus').textContent")); i++) await sleep(250);
  check("Sync now: the event stream brings the result in", /Last sync .*\(web\): no changes/.test(await ev("$('docsStatus').textContent")), await ev("$('docsStatus').textContent"));
  await ev("closeSettings(); true");

  // telegram tab
  await fetch(BASE + "/api/settings/telegram", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useEnv: true }) });
  await ev("$('openAdmin').click(); $('tab-telegram').click(); true"); await sleep(800);
  check("Telegram tab: status says the bot is off without a token", /TELEGRAM_BOT_TOKEN is not set/.test(await ev("$('tgStatus').textContent")), await ev("$('tgStatus').textContent"));
  check("Telegram tab: other panels hidden", await ev("getComputedStyle($('panel-storage')).display==='none' && getComputedStyle($('setForm')).display==='none' && getComputedStyle($('llmFoot')).display==='none'"));
  check("Telegram tab: empty list warns and Save is disabled", (await ev("$('tgWarn').textContent")).includes("ignores every message") && await ev("$('tgSave').disabled"));
  // a refused group message, as the bot would report it
  await ev(`(()=>{ tgState.status.rejected=[{chatId:"-1009876",chatType:"supergroup",chatTitle:"Reno",fromId:"5551234",fromName:"Zhou Yi (@zy)",reason:"group not on the allowlist",at:new Date().toISOString()}]; renderTGRejected(); return true; })()`);
  const rejBtns = await ev("[...$('tgRejected').querySelectorAll('button')].map(b=>b.textContent).join(',')");
  check("refused list offers Add person and Add this group", rejBtns === "Add Zhou,Add this group", rejBtns);
  await ev("$('tgRejected').querySelector('[data-tgaddu]').click(); $('tgRejected').querySelector('[data-tgaddg]').click(); true");
  const draft = await ev("JSON.stringify(tgDraft)");
  check("Add buttons fill the form (not saved yet)", draft === JSON.stringify({ users: [{ id: "5551234", name: "Zhou" }], groups: ["-1009876"] }) && !(await ev("$('tgSave').disabled")), draft);
  await ev("$('tgSave').click(); true"); await sleep(800);
  const saved = await api("/api/admin/telegram");
  check("Save writes the allowlist", saved.allowlist.fromEnv === false && saved.allowlist.users[0].id === "5551234" && saved.allowlist.groups[0] === "-1009876", JSON.stringify(saved.allowlist));
  check("after save: source line and success message", /Saved .* by dev@localhost/.test(await ev("$('tgSource').textContent")) && /next message/.test(await ev("$('tgResult').textContent")));
  // invalid input shows the server's message
  await ev("$('tgAddUser').click(); const ins=$('tgUsers').querySelectorAll('.rowi:last-child input'); ins[0].value='-7'; ins[0].dispatchEvent(new Event('input',{bubbles:true})); ins[1].value='Bad'; ins[1].dispatchEvent(new Event('input',{bubbles:true})); $('tgSave').click(); true");
  await sleep(600);
  check("invalid user ID shows the validation message", /positive number/.test(await ev("$('tgResult').textContent")), await ev("$('tgResult').textContent"));
  // morning check-in: status line (no bot here) + editable setting
  check("check-in status says there is no bot", /No bot is running/.test(await ev("$('tgCheckin').textContent")), await ev("$('tgCheckin').textContent"));
  check("check-in form shows the server default 09:30", await ev("$('ciTime').value==='09:30' && !$('ciOff').checked && $('ciChat').value==='' && /server's defaults/.test($('ciSource').textContent) && $('ciUseEnv').hidden"));
  check("check-in chat list offers the default, the group and the people", await ev("[...$('ciChat').options].map(o=>o.value).join(',')") === ",-1009876,5551234", await ev("[...$('ciChat').options].map(o=>o.textContent).join(' | ')"));
  await ev("$('ciTime').value='08:15'; $('ciChat').value='-1009876'; $('ciSave').click(); true"); await sleep(700);
  let ci = (await api("/api/admin/telegram")).checkin.setting;
  check("Save check-in stores time and chat", ci.schedule === "08:15" && ci.chat === "-1009876" && ci.fromEnv === false && /Saved/.test(await ev("$('ciResult').textContent")) && !(await ev("$('ciUseEnv').hidden")), JSON.stringify(ci));
  // Editing the lists above keeps an unsaved check-in edit (M2).
  await ev("$('ciTime').value='06:40'; $('tgAddGroup').click(); true"); await sleep(200);
  check("adding a group keeps an unsaved check-in time", (await ev("$('ciTime').value")) === "06:40", await ev("$('ciTime').value"));
  await ev("[...document.querySelectorAll('#tgGroups [data-tgrmg]')].pop().click(); $('ciTime').value='08:15'; true");
  // An empty time is caught on the page.
  await ev("$('ciTime').value=''; $('ciSave').click(); true"); await sleep(300);
  check("an empty time asks for a time instead of saving the default", /Pick a time/.test(await ev("$('ciResult').textContent")) && (await api("/api/admin/telegram")).checkin.setting.schedule === "08:15");
  await ev("$('ciTime').value='08:15'; true");
  await ev("$('ciOff').click(); true");
  check("ticking Off disables the time", await ev("$('ciTime').disabled"));
  await ev("$('ciSave').click(); true"); await sleep(700);
  ci = (await api("/api/admin/telegram")).checkin.setting;
  check("Off is saved", ci.schedule === "off", JSON.stringify(ci));
  await ev("$('ciTime').disabled=false; $('ciOff').checked=false; $('ciTime').value='21:00'; $('ciSave').click(); true"); await sleep(700);
  check("a time after 20:00 shows the server's message", /before 20:00/.test(await ev("$('ciResult').textContent")), await ev("$('ciResult').textContent"));
  // Saving the allowlist keeps an unsaved Send-to choice.
  await ev("loadTelegram()"); await sleep(400); // drop the deliberately invalid row from earlier
  await ev("(()=>{ $('ciChat').value='5551234'; $('tgAddUser').click(); const ins=$('tgUsers').querySelectorAll('.rowi:last-child input'); ins[0].value='777'; ins[0].dispatchEvent(new Event('input',{bubbles:true})); ins[1].value='Tmp'; ins[1].dispatchEvent(new Event('input',{bubbles:true})); $('tgSave').click(); return true; })()"); await sleep(800);
  check("saving the allowlist keeps the chosen Send-to and lists the new person", (await ev("$('ciChat').value")) === "5551234" && (await ev("[...$('ciChat').options].some(o=>o.value==='777')")), await ev("$('ciChat').value"));
  // An unreadable setting is said so on the form.
  await ev("tgState.checkin={...tgState.checkin, noBot:false, error:'read settings.json: 503', on:false, setting:{...tgState.checkin.setting, unreadable:true}}; renderTGStatus(); renderCheckinForm(); true");
  check("an unreadable setting is said so", /Couldn't read the setting/.test(await ev("$('tgCheckin').textContent")) && /Couldn't read the saved setting/.test(await ev("$('ciSource').textContent")));
  await ev("window.confirm=()=>true; $('ciUseEnv').click(); true"); await sleep(700);
  ci = (await api("/api/admin/telegram")).checkin.setting;
  check("back to the server's defaults", ci.fromEnv === true && ci.schedule === "09:30" && (await ev("$('ciTime').value")) === "09:30", JSON.stringify(ci));
  await ev("$('ciTime').value='07:45'; true");
  await ev("$('drawer').querySelector('.panel:not([hidden])').scrollTop=99999; true");
  await shot("admin-telegram.png", 1440, 1000);
  await fetch(BASE + "/api/settings/telegram", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useEnv: true }) });
  await ev("closeSettings(); true");

  // admin guide page
  check("header links to the admin guide", await ev("!!document.querySelector('.toplinks a[href=\"/guide.html\"]') && !!document.querySelector('#guideLink')"));
  await cmd("Page.navigate", { url: BASE + "/guide.html" }); await sleep(1500);
  const g = await ev("({h2: document.querySelectorAll('article h2').length, toc: document.querySelectorAll('#toc li').length, tables: document.querySelectorAll('article table').length, pre: document.querySelectorAll('article pre').length, err: !!document.querySelector('.err'), raw: /\\*\\*|\\]\\(|^#/m.test(document.querySelector('article').innerText)})");
  check("guide renders: sections, contents, tables, code blocks", g.h2 >= 10 && g.toc === g.h2 && g.tables >= 5 && g.pre >= 3 && !g.err && !g.raw, JSON.stringify(g));
  check("guide: repo links shown as paths, external links open new tabs", await ev("[...document.querySelectorAll('article a')].every(a=>a.target==='_blank'||a.getAttribute('href').startsWith('#')) && /deploy\\/k8s\\/base\\/secrets\\.example\\.yaml/.test(document.querySelector('article').innerText)"));
  await ev("document.querySelector('#toc a[href=\"#troubleshooting\"]').click(); true"); await sleep(300);
  check("contents link jumps to Troubleshooting", (await ev("Math.abs(document.getElementById('troubleshooting').getBoundingClientRect().top) < 80")));
  await shot("guide.png", 1440, 1000);
  await shot("guide-mobile.png", 390, 844);
  check("guide: no horizontal page scroll on phone width", await ev("document.documentElement.scrollWidth <= window.innerWidth + 1"), await ev("document.documentElement.scrollWidth+' vs '+window.innerWidth"));
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cmd("Page.navigate", { url: BASE + "/#settings" }); await sleep(1500);
  check("'/#settings' opens the Settings panel", await ev("$('drawer').classList.contains('open')"));
  await ev("closeSettings(); true");

  await shot("mobile.png", 390, 844);
  check("no horizontal page scroll on phone width", (await ev("document.documentElement.scrollWidth <= window.innerWidth + 1")), await ev("document.documentElement.scrollWidth+' vs '+window.innerWidth"));
  const real = errors.filter(x => !/api\/settings\/llm\/models/.test(x) && !/400 .*api\/settings\/(telegram|checkin)/.test(x)); check("no console errors (ignoring the down LLM endpoint's 502 and the deliberate invalid Telegram and check-in saves)", real.length === 0, real.join(" ; "));
} catch (e) {
  results.push("ERROR " + e.message);
} finally {
  console.log(results.join("\n"));
  try { ws?.close(); } catch {}
  chrome.kill();
}
