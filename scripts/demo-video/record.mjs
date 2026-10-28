// Records the CollectPilot demo in headless Chrome against the running app (real Claude and PayPal
// sandbox calls). Writes frames, list.txt and cues.json to <outDir>.
//
//   node --env-file=.env scripts/demo-video/record.mjs <baseUrl> <outDir>
//   ffmpeg -f concat -safe 0 -i list.txt -vf "scale=1920:1200,format=yuv420p" -r 30 -c:v libx264 -crf 18 collectpilot-silent.mp4
//
// Signs in with FREELANCER_PASSCODE off camera. The client's AI agent is a real MCP client using the
// agent key in .mcp-client.json; its calls are drawn from the actual responses. About 3 Claude calls
// per take (assistant, draft, review). Waits for the AI, PayPal and page loads are cut.
import { launch, sleep } from "./cdp.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [B, DIR] = process.argv.slice(2);
if (!B || !DIR) throw new Error("usage: record.mjs <baseUrl> <outDir>");
if (!process.env.FREELANCER_PASSCODE) throw new Error("FREELANCER_PASSCODE missing (run with --env-file=.env)");
const BUYER = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
const CARD = fileURLToPath(new URL("./card.html", import.meta.url));
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR + "/frames", { recursive: true });

const b = await launch({ width: 1200, height: 750, scale: 1.6, port: 9393 });

// ---------- captions (also the narration cues) ----------
const cues = [];
let lastCaption = "";
const caption = async (text) => {
  await b.evaluate(`(() => {
    document.querySelectorAll('nextjs-portal').forEach((e) => e.remove());
    let c = document.getElementById('rec-caption');
    if (!c) { c = document.createElement('div'); c.id = 'rec-caption';
      Object.assign(c.style, { position: 'fixed', left: '50%', bottom: '22px', transform: 'translateX(-50%)', zIndex: 2147483600, maxWidth: '980px',
        background: 'rgba(18,32,43,.93)', color: '#fff', font: '600 19px/1.35 -apple-system, system-ui, sans-serif', padding: '11px 20px',
        borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,.25)', textAlign: 'center', pointerEvents: 'none', transition: 'opacity .3s' });
      document.documentElement.appendChild(c); }
    c.textContent = ${JSON.stringify(text)}; c.style.opacity = ${text ? 1 : 0};
  })()`);
};
const say = async (text) => {
  lastCaption = text;
  cues.push({ at: b.mark(), text });
  console.log(b.mark().toFixed(1), text);
  await caption(text);
};
const restoreCaption = async () => {
  await b.evaluate("document.querySelectorAll('nextjs-portal').forEach((e) => e.remove())");
  if (lastCaption) await caption(lastCaption);
};
const hover = (x, y) => b.moveTo({ x, y });

// ---------- DOM helpers ----------
const rect = (js) => b.evaluate(`(() => { const e = ${js}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect();
  return { x: q.x + q.width / 2, y: q.y + Math.min(q.height / 2, 18), react: Object.keys(e).some((k) => k.startsWith('__react')) }; })()`);
const clickEl = async (js, label) => {
  let p;
  for (let i = 0; i < 60; i++) { p = await rect(js); if (p) break; await sleep(250); }
  if (!p) { await b.shot(DIR + "/fail.png"); throw new Error("missing " + label); }
  // Show the pointer and ripple, then activate the element itself (real presses get dropped while frames are captured).
  await b.moveTo(p);
  await b.evaluate(`(() => { const r = document.getElementById('rec-ripple'); if (!r) return; r.style.transition = 'none'; r.style.left = '${p.x}px'; r.style.top = '${p.y}px'; r.style.opacity = 1; r.style.transform = 'scale(.4)'; r.offsetWidth; r.style.transition = 'opacity .5s, transform .5s'; r.style.opacity = 0; r.style.transform = 'scale(1.6)'; })()`);
  await sleep(150);
  await b.evaluate(`(() => { const e = ${js}; if (/^(INPUT|TEXTAREA)$/.test(e.tagName)) e.focus(); else e.click(); })()`);
};
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.includes(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0)`;
const has = (text) => b.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
const hydrated = async () => {
  for (let i = 0; i < 80; i++) {
    if (await b.evaluate("[...document.querySelectorAll('button, a')].some((e) => Object.keys(e).some((k) => k.startsWith('__react')))")) return;
    await sleep(250);
  }
};
const goto = async (url, wait = 5000) => { b.pause(); await b.goto(url, wait); await hydrated(); await sleep(800); await restoreCaption(); await b.resume(); };
// Wait off camera until cond() holds, then let the result sit on screen.
const waitFor = async (cond, label, maxS = 90) => {
  b.pause();
  for (let i = 0; i < maxS * 2 && !(await cond()); i++) await sleep(500);
  if (!(await cond())) { await b.shot(DIR + "/fail.png"); throw new Error("timed out: " + label); }
  await sleep(500); await restoreCaption(); await b.resume();
};
// Text typed into a React field, a few characters at a time so it reads as typing.
const typeInto = async (js, label, text, cps = 40) => {
  await clickEl(js, label);
  for (let i = 0; i < text.length; i += 3) { await b.type(text.slice(i, i + 3)); await sleep(3000 / cps); }
};
const scrollTo = (js) => b.evaluate(`(() => { const e = ${js}; e?.scrollIntoView({ behavior: 'smooth', block: 'center' }); })()`);

// ---------- the client's AI agent: a real MCP client ----------
const mcpConf = JSON.parse(readFileSync(new URL("../../.mcp-client.json", import.meta.url), "utf8")).mcpServers.collectpilot;
const agent = new Client({ name: "client-assistant", version: "1.0.0" });
await agent.connect(new StreamableHTTPClientTransport(new URL(B + "/mcp"), { requestInit: { headers: mcpConf.headers } }));
const callTool = async (name, args = {}) => {
  const r = await agent.callTool({ name, arguments: args });
  const text = r.content?.map((c) => c.text ?? "").join("") ?? "";
  try { return { error: r.isError, data: JSON.parse(text) }; } catch { return { error: r.isError, data: text }; }
};
// A panel drawn over the dashboard, filled from the agent's real calls.
const agentPanel = (lines) => b.evaluate(`(() => {
  let p = document.getElementById('rec-agent');
  if (!p) { p = document.createElement('div'); p.id = 'rec-agent';
    Object.assign(p.style, { position: 'fixed', right: '18px', top: '96px', width: '410px', zIndex: 2147483500, background: '#0f1a22', color: '#e6edf3',
      font: '13px/1.5 ui-monospace, Menlo, monospace', borderRadius: '12px', padding: '14px 16px', boxShadow: '0 14px 40px rgba(0,0,0,.35)', whiteSpace: 'pre-wrap' });
    document.documentElement.appendChild(p); }
  p.innerHTML = ${JSON.stringify(lines)}.map((l) => l.startsWith('#') ? '<div style="font:600 14px -apple-system,system-ui,sans-serif;color:#2fbf8f;margin-bottom:6px">' + l.slice(1) + '</div>' : '<div>' + l.replace(/[<>&]/g, '') + '</div>').join('');
})()`);

const money = (n) => "$" + Number(n).toFixed(2);

// ---------- off camera: sign in ----------
await b.goto(B + "/login", 6000);
await b.evaluate("document.querySelector('#passcode').focus()");
await b.type(process.env.FREELANCER_PASSCODE);
await b.evaluate("document.querySelector('form button').click()");
await sleep(6000);

// ---------- 0. title card ----------
await b.goto("file://" + CARD, 2000);
await b.evaluate("document.getElementById('rec-cursor')?.remove()");
await b.startRec();
await say("CollectPilot: an AI receivables agent that gets freelancers paid through PayPal");
await sleep(6000);

// ---------- 1. dashboard ----------
await goto(B + "/", 9000);
await say("Every PayPal invoice a freelancer sent, live in an AG Studio dashboard, with risk and an expected pay date");
await sleep(2500); await hover(300, 230); await sleep(2000); await hover(560, 390); await sleep(2500);
await say("The AI assistant is AG Studio's agent framework, running on Claude. It reads the live grid");
await clickEl(byText("button", "Which clients are at risk?"), "assistant chip");
// Done when the panel's Stop button is gone and the answer has stopped growing.
let stable = 0, lastLen = 0;
await sleep(1500);
await waitFor(async () => {
  const s = await b.evaluate("({ busy: [...document.querySelectorAll('button')].some((e) => e.textContent.trim() === 'Stop' && e.getBoundingClientRect().width > 0), len: document.body.innerText.length })");
  stable = !s.busy && s.len === lastLen ? stable + 1 : 0; lastLen = s.len;
  return stable >= 4;
}, "assistant answer", 150);
await hover(1000, 420); await sleep(6500);

// ---------- 2. voice note or text to a PayPal invoice ----------
await goto(B + "/invoices/new", 5000);
await say("A new job, typed or spoken in English or Arabic. Claude drafts the PayPal invoice");
await typeInto("document.querySelector('#say')", "say", `Bill Acme Studio 250 dollars for the logo refresh, due in 7 days. ${BUYER}`);
await sleep(800);
await clickEl(byText("button", "Draft invoice"), "Draft invoice");
await waitFor(() => b.evaluate("!!document.querySelector('section[aria-label=\"Review the draft\"]')"), "draft");
await scrollTo("document.querySelector('section[aria-label=\"Review the draft\"]')"); await sleep(4000);
await say("Before sending, AI checks the draft against what was actually agreed");
await clickEl(byText("button", "Check against what was agreed"), "review toggle");
await sleep(800);
const area = (label) => `[...document.querySelectorAll('section[aria-label="Check against what was agreed"] label')].find((l) => l.textContent.includes(${JSON.stringify(label)}))?.querySelector('textarea')`;
await typeInto(area("Agreed quote"), "quote", "Logo refresh: $250 flat, includes 2 revision rounds. Extra rounds are $40 each.", 70);
await typeInto(area("Client messages"), "messages", "Thanks for squeezing in that third round of revisions on Friday!", 70);
await sleep(600);
await clickEl(byText("button", "Check invoice"), "Check invoice");
await waitFor(() => b.evaluate("!document.body.innerText.includes('Checking…') && !!document.querySelector('section[aria-label=\"Check against what was agreed\"] [aria-live]')"), "review");
await scrollTo("document.querySelector('section[aria-label=\"Check against what was agreed\"] [aria-live]')");
// The caption says only what the review actually found.
const suggestion = await b.evaluate(`[...document.querySelectorAll('section[aria-label="Check against what was agreed"] [aria-live] div.border-dashed p')][0]?.textContent ?? ''`);
console.error("suggestion", suggestion);
if (suggestion && (await has("Add as a line"))) {
  await say(`It found work not billed yet: ${suggestion.split("·")[0].trim()}. One tap adds it`);
  await sleep(3500);
  await clickEl(byText("button", "Add as a line"), "Add as a line"); await sleep(2500);
} else {
  await say("Each line is checked against the quote and the client's messages");
  await sleep(4500);
}
const sendBtn = `[...document.querySelectorAll('button')].find((e) => /^Send .* invoice with PayPal$/.test(e.textContent.trim()))`;
await scrollTo(sendBtn); await sleep(2000);
await say("Sent with PayPal Invoicing. The invoice links the client to pay it with their own AI agent");
await clickEl(sendBtn, "Send");
await waitFor(() => has("Invoice sent with PayPal"), "sent");
const sentText = await b.evaluate("document.body.innerText");
const number = sentText.match(/\b([A-Z]{2,4}-[A-Za-z0-9-]+)\s·/)?.[1];
if (!number) throw new Error("no invoice number on the sent card");
console.error("sent", number);
await sleep(4500);

// ---------- 3. the client's AI agent pays over MCP ----------
await goto(B + "/", 9000);
await say("Now the client's side: their own AI agent connects to CollectPilot over MCP");
await sleep(2500);
b.pause();
const owe = await callTool("what_do_i_owe");
const invoices = owe.data?.invoices ?? [];
const target = invoices.find((i) => i.invoice_number === number);
if (!target) throw new Error(`agent does not see ${number}`);
console.error("owe", invoices.map((i) => `${i.invoice_number} ${i.amount_due ?? i.amount}`).join(", "));
const limit = owe.data?.spend_limit_per_payment;
const oweLines = ["#Client's AI agent  ·  MCP", "> what_do_i_owe()", `  limit per payment: ${typeof limit === "object" ? JSON.stringify(limit) : limit}`,
  ...invoices.slice(0, 4).map((i) => `  ${i.invoice_number}  ${money(i.amount_due ?? i.amount?.value ?? i.amount ?? 0)}${i.days_overdue > 0 ? "  overdue" : ""}`)];
await agentPanel(oweLines);
await restoreCaption(); await b.resume();
await sleep(5500);
await say("It pays the new invoice. The capture uses the client's vaulted PayPal token, through the PayPal Server SDK");
b.pause();
const paid = await callTool("pay_invoice", { invoice_id: target.invoice_id ?? target.id });
console.error("pay", JSON.stringify(paid).slice(0, 300));
const capture = JSON.stringify(paid.data).match(/"paypal_capture_id":"([A-Z0-9]{10,})"/)?.[1];
await agentPanel([...oweLines, `> pay_invoice(${target.invoice_number})`, paid.error ? `  refused: ${JSON.stringify(paid.data).slice(0, 120)}` : `  paid ${money(target.amount_due ?? target.amount?.value ?? 0)}${capture ? "  capture " + capture : ""}`]);
await restoreCaption(); await b.resume();
await sleep(3000);
await say("PayPal's webhook lands and the freelancer's dashboard updates live");
await waitFor(() => b.evaluate(`(() => { const r = [...document.querySelectorAll('[role=row], tr, div')].find((e) => e.textContent.startsWith(${JSON.stringify(number)}) && e.textContent.length < 200); return !!r && /Paid/.test(r.textContent) && !/Part paid/.test(r.textContent); })()`), "live paid row", 120);
await sleep(6000);
await b.evaluate("document.getElementById('rec-agent')?.remove()");

// ---------- 4. schedules, retainers, digest ----------
await goto(B + "/schedules", 5000);
await say("Bigger jobs become milestone schedules. The client approves the dates once and can turn on auto-pay");
await sleep(5500);
const payLink = await b.evaluate("document.body.innerText.match(/https?:\\/\\/\\S+\\/pay\\/[\\w-]+/)?.[0] ?? ''");
if (!payLink) throw new Error("no client schedule link");
await goto(payLink, 6000);
await say("The client's page: approve the dates once, turn on auto-pay, or mark a part “Not done yet”");
await sleep(3000);
await scrollTo(byText("button", "Not done yet")); await sleep(1500);
const nd = await rect(byText("button", "Not done yet"));
if (nd) await b.moveTo(nd);
await say("A held part gets no reminder and no charge, not even by an agent, until a new date is approved");
await sleep(6000);
await goto(B + "/retainers", 5000);
await say("Repeat clients become monthly retainers on PayPal Subscriptions");
await sleep(5500);
await goto(B + "/digest", 6000);
await say("The digest shows what the agents collected, against the cost of the plan");
await sleep(6000);

// ---------- 5. end card ----------
b.pause(); await b.goto("file://" + CARD + "?end=1", 2000); await b.evaluate("document.getElementById('rec-cursor')?.remove()"); await b.resume();
lastCaption = "";
await say("CollectPilot. Get paid through PayPal, even by your client's AI");
await sleep(6000);

const { frames, end } = await b.stopRec();
b.close();
await agent.close();

const FPS = 30, start = frames[0].t, slots = Math.ceil((end - start) * FPS);
const list = []; let j = 0; const written = new Map();
for (let s = 0; s < slots; s++) {
  const t = start + s / FPS;
  while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
  if (!written.has(j)) { const name = `frames/${String(j).padStart(5, "0")}.jpg`; writeFileSync(DIR + "/" + name, Buffer.from(frames[j].data, "base64")); written.set(j, name); }
  list.push(`file '${written.get(j)}'`, `duration ${(1 / FPS).toFixed(6)}`);
}
list.push(list[list.length - 2]);
writeFileSync(DIR + "/list.txt", list.join("\n") + "\n");
writeFileSync(DIR + "/cues.json", JSON.stringify(cues.map((c) => ({ at: Math.max(0, c.at - start), text: c.text })), null, 1));
console.log(`frames ${frames.length}, length ${(end - start).toFixed(1)} s`);
