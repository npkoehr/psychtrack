import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

/* ── Supabase ── */
const supabase = createClient(
  "https://djvubojqktgqhzntnlev.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqdnVib2pxa3RncWh6bnRubGV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMjYwODQsImV4cCI6MjA4NzcwMjA4NH0.2t8G6-USt99oU5I2yQH3c7k3DuBa4wt8f5cZtDgjEd4"
);

/* ── Password / Auth ──
   Default password is: psychtrack2025
   The app stores only a SHA-256 hash in localStorage — never the plain password.
   To change the password: click the lock icon in the sidebar footer.
*/
const DEFAULT_PASSWORD = "psychtrack2025";
const HASH_KEY = "pt-auth-hash";
const SESSION_KEY = "pt-session";

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getStoredHash() {
  const h = localStorage.getItem(HASH_KEY);
  if (h) return h;
  const def = await sha256(DEFAULT_PASSWORD);
  localStorage.setItem(HASH_KEY, def);
  return def;
}

async function checkPassword(input) {
  const stored = await getStoredHash();
  const inputHash = await sha256(input);
  return inputHash === stored;
}

async function changePassword(currentInput, newInput) {
  const ok = await checkPassword(currentInput);
  if (!ok) return false;
  const newHash = await sha256(newInput);
  localStorage.setItem(HASH_KEY, newHash);
  return true;
}

function setSession() { localStorage.setItem(SESSION_KEY, Date.now().toString()); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function hasValidSession() {
  const t = localStorage.getItem(SESSION_KEY);
  if (!t) return false;
  // Session expires after 8 hours
  return Date.now() - Number(t) < 8 * 60 * 60 * 1000;
}

/* ── DB helpers ── */
async function fetchStudents() {
  const { data, error } = await supabase.from("students").select("data");
  if (error) { console.error("fetchStudents:", error); return []; }
  return (data || []).map(r => r.data);
}
async function fetchSessions() {
  const { data, error } = await supabase.from("sessions").select("data");
  if (error) { console.error("fetchSessions:", error); return []; }
  return (data || []).map(r => r.data);
}
async function upsertStudent(student) {
  const { error } = await supabase.from("students").upsert({ id: student.id, data: student, updated_at: new Date().toISOString() });
  if (error) console.error("upsertStudent:", error);
}
async function removeStudent(id) {
  const { error } = await supabase.from("students").delete().eq("id", id);
  if (error) console.error("removeStudent:", error);
}
async function upsertSession(session) {
  const { error } = await supabase.from("sessions").upsert({ id: session.id, student_id: session.studentId, data: session });
  if (error) console.error("upsertSession:", error);
}
async function removeSession(id) {
  const { error } = await supabase.from("sessions").delete().eq("id", id);
  if (error) console.error("removeSession:", error);
}
async function removeSessionsByStudent(studentId) {
  const { error } = await supabase.from("sessions").delete().eq("student_id", studentId);
  if (error) console.error("removeSessionsByStudent:", error);
}

/* ── Utilities ── */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowYM = () => new Date().toISOString().slice(0, 7);

function ymLabel(ym) {
  const [y, m] = ym.split("-");
  return new Date(+y, +m - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function getYMOptions() {
  const opts = [], now = new Date();
  for (let i = -3; i <= 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    opts.push(d.toISOString().slice(0, 7));
  }
  return opts;
}
function minutesUsedInMonth(sessions, studentId, ym) {
  return sessions
    .filter(s => s.studentId === studentId && s.date.startsWith(ym))
    .reduce((a, s) => ({ direct: a.direct + (Number(s.directMinutes) || 0), indirect: a.indirect + (Number(s.indirectMinutes) || 0) }), { direct: 0, indirect: 0 });
}
function weeksLeftInMonth(ym) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0);
  return Math.max(0.5, Math.max(0, last.getTime() - now.getTime()) / (7 * 86400000));
}
function isAfterFirstWeekFor(ym) {
  const now = new Date();
  const [y, m] = ym.split("-").map(Number);
  if (now.getFullYear() === y && now.getMonth() + 1 === m) return now.getDate() > 7;
  return new Date(y, m, 0) < now;
}
function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const target = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

/* ── Multi-goal helper ── */
function getStudentGoals(student) {
  if (student.goals && student.goals.length > 0) return student.goals;
  // Legacy: single goal stored at root level
  if (student.iepGoal || student.goalType) {
    return [{ id: (student.id||"x")+"-g1", description: student.iepGoal||"", goalType: student.goalType||"trials",
      trialSize: student.trialSize||5, rubricLevels: student.rubricLevels||[], pmGoalScore: student.pmGoalScore||"", lastPmDate: student.lastPmDate||"" }];
  }
  return [];
}

/* ── Excel Export ── */
function exportToExcel(students, sessions) {
  if (!window.XLSX) { alert("Export library still loading, please try again."); return; }
  const wb = window.XLSX.utils.book_new();
  const sData = [["ID","Name","Grade","Direct Min/Month","Indirect Min/Month","Goal Type","IEP Goal","Rubric Levels","Meeting Type","Meeting Due Date","Meeting Scheduled","Meeting Completed"]];
  students.forEach(s => sData.push([s.id, s.name, s.grade||"", s.directMinutesPerMonth, s.indirectMinutesPerMonth, s.goalType, s.iepGoal||"", (s.rubricLevels||[]).join(" | "), s.meetingType||"", s.meetingDueDate||"", s.meetingScheduledDate||"", s.meetingCompleted?"Yes":"No"]));
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(sData), "Students");
  const sessData = [["Session ID","Student Name","Date","Direct Min","Indirect Min","Notes","Correct Trials","Incorrect Trials","Rubric Score"]];
  sessions.forEach(s => {
    const st = students.find(x => x.id === s.studentId);
    sessData.push([s.id, st?.name||"Unknown", s.date, s.directMinutes||0, s.indirectMinutes||0, s.notes||"", s.goalData?.correct??"", s.goalData?.incorrect??"", s.goalData?.rubricScore||""]);
  });
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(sessData), "Sessions");
  const months = [...new Set(sessions.map(s => s.date.slice(0, 7)))].sort();
  const sumData = [["Student","Month","Allotted Direct","Used Direct","Remaining Direct","Allotted Indirect","Used Indirect","Remaining Indirect"]];
  students.forEach(st => {
    (months.length ? months : [nowYM()]).forEach(ym => {
      const used = minutesUsedInMonth(sessions, st.id, ym);
      sumData.push([st.name, ymLabel(ym), st.directMinutesPerMonth, used.direct, st.directMinutesPerMonth - used.direct, st.indirectMinutesPerMonth, used.indirect, st.indirectMinutesPerMonth - used.indirect]);
    });
  });
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(sumData), "Monthly Summary");
  window.XLSX.writeFile(wb, `caseload-${nowYM()}.xlsx`);
}

/* ── Styles ── */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f2f6f4;--sidebar:#172b23;--sb-h:#213d30;--sb-a:#2b5040;
  --pri:#2d7d5e;--pri-l:#3d9e7a;
  --red:#b83232;--ora:#d4721a;--grn:#1f6e4a;--yel:#a07010;
  --txt:#162820;--txt2:#547060;--bdr:#d4e4dc;--card:#fff;
  --inp:#edf4f0;--shd:0 2px 12px rgba(20,50,35,.08);--shd2:0 6px 28px rgba(20,50,35,.13)
}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--txt);font-size:14px}
.app{display:flex;min-height:100vh}

/* ── Login Screen ── */
.login-wrap{min-height:100vh;background:var(--sidebar);display:flex;align-items:center;justify-content:center;padding:20px;position:relative;overflow:hidden}
.login-wrap::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 30% 50%, rgba(45,125,94,.25) 0%, transparent 65%),radial-gradient(ellipse at 80% 20%, rgba(45,125,94,.15) 0%, transparent 50%)}
.login-box{background:rgba(255,255,255,.04);border:1px solid rgba(184,218,202,.12);border-radius:20px;padding:42px 40px;width:100%;max-width:400px;position:relative;z-index:1;backdrop-filter:blur(12px);box-shadow:0 24px 80px rgba(0,0,0,.35)}
.login-logo{text-align:center;margin-bottom:32px}
.login-logo h1{font-family:'Lora',serif;color:#b8daca;font-size:26px;font-weight:600;letter-spacing:-.01em}
.login-logo p{color:rgba(184,218,202,.4);font-size:13px;margin-top:5px}
.login-lock{font-size:42px;margin-bottom:16px;display:block;text-align:center;filter:drop-shadow(0 0 16px rgba(45,200,120,.3))}
.login-label{display:block;font-size:11px;font-weight:600;color:rgba(184,218,202,.5);margin-bottom:6px;letter-spacing:.06em;text-transform:uppercase}
.login-input{width:100%;padding:11px 14px;border:1.5px solid rgba(184,218,202,.15);border-radius:10px;font-size:14px;font-family:inherit;background:rgba(255,255,255,.06);color:#e8f5ef;outline:none;transition:all .2s;letter-spacing:.05em}
.login-input::placeholder{color:rgba(184,218,202,.25);letter-spacing:0}
.login-input:focus{border-color:rgba(45,125,94,.7);background:rgba(255,255,255,.09)}
.login-btn{width:100%;padding:12px;border:none;border-radius:10px;background:var(--pri);color:#fff;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .2s;margin-top:18px;letter-spacing:.02em}
.login-btn:hover{background:var(--pri-l);transform:translateY(-1px);box-shadow:0 6px 20px rgba(45,125,94,.35)}
.login-btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.login-err{color:#f08080;font-size:12.5px;text-align:center;margin-top:10px;padding:8px;background:rgba(180,50,50,.12);border-radius:8px;border:1px solid rgba(180,50,50,.2)}
.login-hint{text-align:center;margin-top:16px;font-size:11.5px;color:rgba(184,218,202,.3)}

/* ── Sidebar ── */
.sb{width:210px;min-height:100vh;background:var(--sidebar);position:fixed;left:0;top:0;bottom:0;z-index:100;display:flex;flex-direction:column;box-shadow:3px 0 18px rgba(0,0,0,.18)}
.sb-logo{padding:22px 18px 18px;border-bottom:1px solid rgba(255,255,255,.07)}
.sb-logo h1{font-family:'Lora',serif;color:#b8daca;font-size:16px;font-weight:600}
.sb-logo p{color:rgba(184,218,202,.45);font-size:11px;margin-top:3px}
.sb-sync{display:flex;align-items:center;gap:6px;padding:8px 13px 4px;font-size:11px;color:rgba(184,218,202,.4)}
.sb-sync.live{color:#5dba8a}.sb-sync.err{color:#e07070}.sb-sync.syncing{color:#f0c060}
.sb-nav{padding:6px 9px;flex:1}
.ni{display:flex;align-items:center;gap:10px;padding:9px 13px;border-radius:8px;color:rgba(184,218,202,.6);cursor:pointer;font-size:13px;transition:all .15s;margin-bottom:2px}
.ni:hover{background:var(--sb-h);color:#b8daca}
.ni.active{background:var(--sb-a);color:#fff;font-weight:500}
.ni-ico{font-size:15px;width:20px;text-align:center}
.sb-foot{padding:12px 9px;border-top:1px solid rgba(255,255,255,.07)}

/* ── Main ── */
.main{margin-left:210px;flex:1;display:flex;flex-direction:column;min-height:100vh}
.topbar{background:#fff;border-bottom:1px solid var(--bdr);padding:13px 26px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;box-shadow:0 1px 6px rgba(20,50,35,.06)}
.topbar h2{font-family:'Lora',serif;font-size:19px;font-weight:600}
.topbar-r{display:flex;gap:10px;align-items:center}
.content{padding:22px 26px;flex:1}

/* ── Cards ── */
.card{background:var(--card);border-radius:12px;box-shadow:var(--shd);border:1px solid var(--bdr)}
.ch{padding:14px 18px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between}
.ct{font-family:'Lora',serif;font-size:14.5px;font-weight:600}
.cb{padding:18px}

/* ── Buttons ── */
.btn{padding:7px 15px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:500;font-family:inherit;transition:all .15s;display:inline-flex;align-items:center;gap:5px}
.btn-p{background:var(--pri);color:#fff}.btn-p:hover{background:var(--pri-l)}
.btn-o{background:transparent;color:var(--pri);border:1.5px solid var(--pri)}.btn-o:hover{background:rgba(45,125,94,.07)}
.btn-d{background:#fde8e8;color:var(--red)}.btn-d:hover{background:#fcc}
.btn-g{background:transparent;color:var(--txt2)}.btn-g:hover{background:var(--inp)}
.btn-xl{background:#1a5e38;color:#fff}.btn-xl:hover{background:#144d2e}
.btn-sm{padding:5px 10px;font-size:12px}
.btn:disabled{opacity:.4;cursor:not-allowed}

/* ── Form ── */
.fg{margin-bottom:13px}
.fl{display:block;font-size:11px;font-weight:600;color:var(--txt2);margin-bottom:4px;letter-spacing:.04em;text-transform:uppercase}
.fc{width:100%;padding:8px 11px;border:1.5px solid var(--bdr);border-radius:8px;font-size:13.5px;font-family:inherit;background:var(--inp);color:var(--txt);transition:border-color .15s;outline:none}
.fc:focus{border-color:var(--pri);background:#fff}
textarea.fc{resize:vertical;min-height:76px}
select.fc{cursor:pointer}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:13px}

/* ── Table ── */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{padding:9px 13px;text-align:left;font-size:10.5px;font-weight:600;color:var(--txt2);text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid var(--bdr);background:var(--inp)}
.tbl td{padding:11px 13px;border-bottom:1px solid #eaf0ec;vertical-align:middle}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:#f8faf9}
.rg td{background:#d1f5e5!important}
.ro td{background:#fde8cc!important}.ro td:first-child{font-weight:700}
.rr td{background:#fde0e0!important}
.ry td{background:#fef6cd!important}

/* ── Badges ── */
.bdg{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500;white-space:nowrap}
.bdg-a{background:#dbeafe;color:#1d4ed8}
.bdg-r{background:#ede9fe;color:#6d28d9}
.bdg-g{background:#d1f5e5;color:#065f46}
.bdg-o{background:#fde8cc;color:#924a0a}
.bdg-rd{background:#fde0e0;color:#991b1b}
.bdg-y{background:#fef6cd;color:#78450a}
.bdg-n{background:var(--inp);color:var(--txt2)}

/* ── Modal ── */
.mo{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px;backdrop-filter:blur(3px)}
.md{background:#fff;border-radius:14px;box-shadow:var(--shd2);width:100%;max-width:580px;max-height:92vh;overflow-y:auto;animation:slideUp .2s ease}
@keyframes slideUp{from{transform:translateY(18px);opacity:0}to{transform:translateY(0);opacity:1}}
.mh{padding:18px 22px 15px;border-bottom:1px solid var(--bdr);display:flex;justify-content:space-between;align-items:center}
.mt2{font-family:'Lora',serif;font-size:16px;font-weight:600}
.mb2{padding:18px 22px}
.mf{padding:14px 22px;border-top:1px solid var(--bdr);display:flex;justify-content:flex-end;gap:10px}

/* ── Stats ── */
.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:18px}
.sc{background:#fff;border-radius:10px;padding:13px 15px;border:1px solid var(--bdr);box-shadow:0 1px 4px rgba(20,50,35,.05)}
.sl{font-size:10.5px;color:var(--txt2);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.sv{font-size:21px;font-weight:600;font-family:'Lora',serif}

/* ── Misc ── */
.pw{height:5px;background:var(--bdr);border-radius:3px;overflow:hidden;margin-top:3px}
.pb{height:100%;border-radius:3px;transition:width .3s}
.div{height:1px;background:var(--bdr);margin:14px 0}
.sec{font-family:'Lora',serif;font-size:11.5px;font-weight:600;color:var(--txt2);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px}
.pill-wrap{display:flex;gap:6px;flex-wrap:wrap}
.pill{padding:5px 12px;border-radius:20px;font-size:12.5px;cursor:pointer;border:1.5px solid var(--bdr);background:#fff;transition:all .15s;font-family:inherit}
.pill.sel{background:var(--pri);color:#fff;border-color:var(--pri)}
.pill:hover:not(.sel){background:var(--inp)}
.tag{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:var(--inp);border:1px solid var(--bdr);border-radius:6px;font-size:12px}
.tag-x{cursor:pointer;color:var(--txt2);font-size:14px;line-height:1}.tag-x:hover{color:var(--red)}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}
.empty{text-align:center;padding:44px 20px;color:var(--txt2)}
.empty-i{font-size:38px;margin-bottom:10px}
.empty p{font-size:13.5px;line-height:1.6}
.xbtn{background:none;border:none;font-size:20px;cursor:pointer;color:var(--txt2);padding:1px 5px;border-radius:4px}
.xbtn:hover{color:var(--txt);background:var(--inp)}
.alert-i{padding:9px 13px;border-radius:8px;font-size:12.5px;margin-bottom:11px;background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd}
.muted{color:var(--txt2)}
.sm{font-size:12px}
.pw-show{position:absolute;right:11px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:rgba(184,218,202,.4);font-size:16px;padding:2px}
.pw-show:hover{color:rgba(184,218,202,.8)}
.pw-wrap{position:relative}
.chk-btn{background:none;border:none;cursor:pointer;font-size:20px;padding:2px 4px;border-radius:4px;transition:transform .1s}
.chk-btn:hover{transform:scale(1.2)}

/* ── Mobile responsive ── */
html{overflow-y:scroll}
body{overflow-x:hidden;max-width:100%}
.sg4{grid-template-columns:repeat(4,1fr)}

@media(max-width:700px){
  /* ── Base ── */
  body{font-size:15px;touch-action:pan-y}
  .sb{display:none}
  .app{display:block}
  .main{margin-left:0;padding-bottom:72px}
  .content{padding:12px;box-sizing:border-box;width:100%}
  .topbar{padding:11px 14px}
  .topbar h2{font-size:16px}
  .topbar-r .sm{display:none}
  .btn-xl{display:none}

  /* ── Cards ── */
  .card{border-radius:10px}
  .ch{padding:12px 14px;flex-wrap:wrap;gap:6px}
  .cb{padding:14px}
  .ct{font-size:15px}

  /* ── Forms ── */
  .fg{margin-bottom:14px}
  .fl{font-size:12px;margin-bottom:5px}
  .fc{font-size:16px;padding:12px 13px;border-radius:9px}
  select.fc{font-size:16px}
  textarea.fc{font-size:16px;min-height:72px}
  .fr{grid-template-columns:1fr}
  .fr3{grid-template-columns:1fr}

  /* ── Buttons & pills ── */
  .btn{font-size:14px;padding:10px 16px;border-radius:9px}
  .btn-sm{font-size:13px;padding:8px 13px}
  .pill{font-size:14px;padding:9px 15px}

  /* ── Stats grid: 2 cols ── */
  .sg{grid-template-columns:1fr 1fr;gap:8px}
  .sg4{grid-template-columns:1fr 1fr}
  .sc{padding:11px 13px}
  .sl{font-size:11px}
  .sv{font-size:20px}

  /* ── Tracking page: single column ── */
  .track-grid{grid-template-columns:1fr!important}

  /* ── Modal: slides up from bottom ── */
  .mo{align-items:flex-end;padding:0}
  .md{width:100%!important;max-width:100%!important;max-height:90vh;border-radius:18px 18px 0 0;
      position:fixed;bottom:0;left:0;right:0;margin:0}
  .mh{padding:14px 16px 12px}
  .mb2{padding:14px 16px}
  .mf{padding:12px 16px;gap:8px}

  /* ── Tables: scroll within card, never push page ── */
  .tbl-wrap{overflow-x:auto;width:100%}
  .tbl{font-size:13px}
  .tbl th{padding:8px 10px;font-size:11px;white-space:nowrap}
  .tbl td{padding:9px 10px;white-space:nowrap}
  .hide-mob{display:none!important}

  /* ── Login ── */
  .login-box{padding:32px 20px;border-radius:16px}

  /* ── Misc ── */
  .alert-i{font-size:13px}
  .sec{font-size:12px}
  .cal-nav{gap:6px}
  .gp-stats{grid-template-columns:1fr 1fr!important}
}
/* ── Bottom nav (mobile only) ── */
.bnav{display:none}
@media(max-width:768px){
  .bnav{display:flex;position:fixed;bottom:0;left:0;right:0;background:var(--sidebar);z-index:200;padding:8px 0 max(10px,env(safe-area-inset-bottom));box-shadow:0 -2px 20px rgba(0,0,0,.3)}
  .bni{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0;cursor:pointer;color:rgba(184,218,202,.5);transition:color .15s;border:none;background:none;font-family:inherit}
  .bni.active{color:#fff}
  .bni-ico{font-size:22px;line-height:1}
  .bni-lbl{font-size:10px;font-weight:600;letter-spacing:.03em;text-transform:uppercase}
}
`;

/* ══════════════════════════════════════
   LOGIN SCREEN
══════════════════════════════════════ */
function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const handleLogin = async () => {
    if (!password) return;
    setLoading(true);
    setError("");
    const ok = await checkPassword(password);
    if (ok) {
      setSession();
      onLogin();
    } else {
      setError("Incorrect password. Please try again.");
      setPassword("");
    }
    setLoading(false);
  };

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-logo">
          <span className="login-lock">🔒</span>
          <h1>PsychTrack</h1>
          <p>Caseload Manager · Secure Access</p>
        </div>
        <div className="fg">
          <label className="login-label">Password</label>
          <div className="pw-wrap">
            <input
              className="login-input"
              type={showPw ? "text" : "password"}
              placeholder="Enter your password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoFocus
            />
            <button className="pw-show" onClick={() => setShowPw(v => !v)}>{showPw ? "🙈" : "👁️"}</button>
          </div>
        </div>
        {error && <div className="login-err">{error}</div>}
        <button className="login-btn" onClick={handleLogin} disabled={loading || !password}>
          {loading ? "Checking…" : "Unlock App →"}
        </button>
        <div className="login-hint">Default password: psychtrack2025 — change it inside the app</div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════
   CHANGE PASSWORD MODAL
══════════════════════════════════════ */
function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const handleChange = async () => {
    setError("");
    if (next.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setError("New passwords do not match."); return; }
    setLoading(true);
    const ok = await changePassword(current, next);
    if (ok) {
      setSuccess(true);
      setTimeout(() => { clearSession(); window.location.reload(); }, 2000);
    } else {
      setError("Current password is incorrect.");
    }
    setLoading(false);
  };

  return (
    <div className="mo" onClick={onClose}>
      <div className="md" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
        <div className="mh">
          <span className="mt2">🔐 Change Password</span>
          <button className="xbtn" onClick={onClose}>×</button>
        </div>
        <div className="mb2">
          {success ? (
            <div style={{ textAlign:"center", padding:"18px 0" }}>
              <div style={{ fontSize:36, marginBottom:10 }}>✅</div>
              <p style={{ fontWeight:600, color:"var(--grn)" }}>Password changed!</p>
              <p className="sm muted" style={{ marginTop:6 }}>Logging you out now…</p>
            </div>
          ) : (
            <>
              <div className="fg">
                <label className="fl">Current Password</label>
                <div className="pw-wrap" style={{ position:"relative" }}>
                  <input className="fc" type={showCurrent ? "text" : "password"} placeholder="Your current password" value={current} onChange={e => setCurrent(e.target.value)} style={{ paddingRight:36 }} />
                  <button className="pw-show" style={{ color:"var(--txt2)" }} onClick={() => setShowCurrent(v=>!v)}>{showCurrent?"🙈":"👁️"}</button>
                </div>
              </div>
              <div className="fg">
                <label className="fl">New Password</label>
                <div className="pw-wrap" style={{ position:"relative" }}>
                  <input className="fc" type={showNew ? "text" : "password"} placeholder="At least 8 characters" value={next} onChange={e => setNext(e.target.value)} style={{ paddingRight:36 }} />
                  <button className="pw-show" style={{ color:"var(--txt2)" }} onClick={() => setShowNew(v=>!v)}>{showNew?"🙈":"👁️"}</button>
                </div>
              </div>
              <div className="fg">
                <label className="fl">Confirm New Password</label>
                <input className="fc" type="password" placeholder="Repeat new password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key==="Enter"&&handleChange()} />
              </div>
              {error && <div style={{ color:"var(--red)", fontSize:12.5, padding:"7px 11px", background:"#fde8e8", borderRadius:8, marginBottom:8 }}>{error}</div>}
              <div style={{ fontSize:12, color:"var(--txt2)", background:"var(--inp)", padding:"9px 12px", borderRadius:8 }}>
                🔒 Passwords are stored as SHA-256 hashes — never in plain text.
              </div>
            </>
          )}
        </div>
        {!success && (
          <div className="mf">
            <button className="btn btn-g" onClick={onClose}>Cancel</button>
            <button className="btn btn-p" onClick={handleChange} disabled={loading || !current || !next || !confirm}>
              {loading ? "Saving…" : "Change Password"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════
   MAIN APP
══════════════════════════════════════ */
export default function App() {
  const [authed, setAuthed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [page, setPage] = useState("tracking");
  const [students, setStudents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState("live");
  const [showChangePw, setShowChangePw] = useState(false);

  /* Check existing session on mount */
  useEffect(() => {
    if (hasValidSession()) setAuthed(true);
    setAuthChecked(true);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    document.head.appendChild(s);
  }, []);

  /* Load data once authed */
  useEffect(() => {
    if (!authed) return;
    (async () => {
      const [st, se] = await Promise.all([fetchStudents(), fetchSessions()]);
      setStudents(st);
      setSessions(se);
      setLoading(false);
    })();
  }, [authed]);

  /* Real-time */
  useEffect(() => {
    if (!authed) return;
    const channel = supabase
      .channel("realtime-all")
      .on("postgres_changes", { event: "*", schema: "public", table: "students" }, payload => {
        setSyncStatus("live");
        if (payload.eventType === "DELETE") {
          setStudents(prev => prev.filter(s => s.id !== payload.old.id));
        } else {
          setStudents(prev => [...prev.filter(s => s.id !== payload.new.id), payload.new.data]);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, payload => {
        setSyncStatus("live");
        if (payload.eventType === "DELETE") {
          setSessions(prev => prev.filter(s => s.id !== payload.old.id));
        } else {
          setSessions(prev => [payload.new.data, ...prev.filter(s => s.id !== payload.new.id)]);
        }
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") setSyncStatus("live");
        if (status === "CHANNEL_ERROR") setSyncStatus("err");
      });
    return () => supabase.removeChannel(channel);
  }, [authed]);

  // Split students vs groups
  const realStudents = students.filter(s => !s.isGroup);
  const groups = students.filter(s => s.isGroup);

  const saveStudent = useCallback(async (student) => { setSyncStatus("syncing"); await upsertStudent(student); }, []);
  const deleteStudentFn = useCallback(async (id) => {
    setSyncStatus("syncing");
    await removeSessionsByStudent(id);
    await removeStudent(id);
    setSessions(prev => prev.filter(s => s.studentId !== id));
    setStudents(prev => prev.filter(s => s.id !== id));
  }, []);
  const saveSessionFn = useCallback(async (session) => { setSyncStatus("syncing"); await upsertSession(session); }, []);
  const saveGroupSessionFn = useCallback(async (group, sessionTemplate) => {
    setSyncStatus("syncing");
    const memberIds = group.memberIds || [];
    await Promise.all(memberIds.map(memberId => {
      const s = { ...sessionTemplate, id: uid(), studentId: memberId, groupId: group.id, groupName: group.name };
      return upsertSession(s);
    }));
  }, []);

  const toggleDocumentedFn = useCallback(async (session) => {
    const updated = { ...session, documented: !session.documented };
    setSyncStatus("syncing");
    await upsertSession(updated);
    setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
  }, []);
  const deleteSessionFn = useCallback(async (id) => {
    setSyncStatus("syncing");
    await removeSession(id);
    setSessions(prev => prev.filter(s => s.id !== id));
  }, []);

  const handleLogout = () => { clearSession(); setAuthed(false); };

  if (!authChecked) return null;
  if (!authed) return <><style>{CSS}</style><LoginScreen onLogin={() => setAuthed(true)} /></>;

  if (loading) return (
    <>
      <style>{CSS}</style>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", background:"#f2f6f4" }}>
        <div style={{ textAlign:"center", color:"#547060" }}>
          <div style={{ fontSize:36, marginBottom:12 }}>🌿</div>
          <p>Connecting to Supabase…</p>
        </div>
      </div>
    </>
  );

  const nav = [
    { id: "tracking", ico: "📝", label: "Tracking" },
    { id: "services", ico: "⏱️", label: "Services" },
    { id: "goals",    ico: "📈", label: "Goal Progress" },
    { id: "meetings", ico: "📅", label: "Meetings" },
    { id: "manage",   ico: "👥", label: "Manage Students" },
  ];
  const titles = { tracking: "Session Tracking", services: "Services", goals: "Goal Progress", meetings: "Meetings", manage: "Manage Students" };
  const syncLabel = syncStatus === "syncing" ? "⟳ Syncing…" : syncStatus === "err" ? "⚠ Sync error" : "● Live";

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <nav className="sb">
          <div className="sb-logo">
            <h1>PsychTrack</h1>
            <p>Caseload Manager</p>
          </div>
          <div className={`sb-sync ${syncStatus}`}>{syncLabel}</div>
          <div className="sb-nav">
            {nav.map(n => (
              <div key={n.id} className={`ni ${page === n.id ? "active" : ""}`} onClick={() => setPage(n.id)}>
                <span className="ni-ico">{n.ico}</span>{n.label}
              </div>
            ))}
          </div>
          <div className="sb-foot">
            <div className="ni" onClick={() => exportToExcel(students, sessions)}>
              <span className="ni-ico">⬇️</span>Export Excel
            </div>
            <div className="ni" onClick={() => setShowChangePw(true)}>
              <span className="ni-ico">🔐</span>Change Password
            </div>
            <div className="ni" onClick={handleLogout}>
              <span className="ni-ico">🚪</span>Lock App
            </div>
          </div>
        </nav>

        <main className="main">
          <div className="topbar">
            <h2>{titles[page]}</h2>
            <div className="topbar-r">
              <span className="sm muted">{realStudents.filter(s=>!s.studentType||s.studentType==="IEP").length} IEP · {realStudents.filter(s=>s.studentType==="504").length} 504 · {realStudents.filter(s=>s.studentType==="GenEd").length} GenEd · {sessions.length} sessions</span>
              <button className="btn btn-xl btn-sm" onClick={() => exportToExcel(students, sessions)}>⬇️ Export Excel</button>
            </div>
          </div>
          <div className="content">
            {page === "tracking" && <TrackingPage students={realStudents} groups={groups} sessions={sessions} saveSession={saveSessionFn} saveGroupSession={saveGroupSessionFn} deleteSession={deleteSessionFn} toggleDocumented={toggleDocumentedFn} />}
            {page === "services" && <ServicesPage students={realStudents} sessions={sessions} />}
            {page === "meetings" && <MeetingsPage students={realStudents} saveStudent={saveStudent} />}
            {page === "goals"    && <GoalProgressPage students={realStudents} sessions={sessions} />}
            {page === "manage"   && <ManagePage students={realStudents} groups={groups} sessions={sessions} saveStudent={saveStudent} deleteStudent={deleteStudentFn} allStudents={students} />}
          </div>
        </main>

        {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}

        {/* Mobile bottom nav */}
        <nav className="bnav">
          {[
            { id:"tracking", ico:"📝", lbl:"Track" },
            { id:"services", ico:"⏱️", lbl:"Services" },
            { id:"goals",    ico:"📈", lbl:"Goals" },
            { id:"meetings", ico:"📅", lbl:"Meetings" },
            { id:"manage",   ico:"👥", lbl:"Students" },
          ].map(n => (
            <button key={n.id} className={`bni ${page===n.id?"active":""}`} onClick={() => setPage(n.id)}>
              <span className="bni-ico">{n.ico}</span>
              <span className="bni-lbl">{n.lbl}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}


/* ── Group trials into sets of 5 across sessions ── */
function groupTrialsIntoSets(sessions, studentId, trialSize = 5) {
  // Collect all trials in chronological order
  const allTrials = [];
  const sorted = [...sessions]
    .filter(s => s.studentId === studentId && s.goalData?.trials?.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach(s => {
    s.goalData.trials.forEach(t => allTrials.push({ t, date: s.date }));
  });
  // Group into sets of trialSize
  const sets = [];
  for (let i = 0; i < allTrials.length; i += trialSize) {
    const chunk = allTrials.slice(i, i + trialSize);
    if (chunk.length === trialSize) {
      const correct = chunk.filter(x => x.t === "C").length;
      sets.push({
        setNum: sets.length + 1,
        trials: chunk,
        correct,
        total: trialSize,
        pct: Math.round((correct / trialSize) * 100),
        startDate: chunk[0].date,
        endDate: chunk[chunk.length - 1].date,
      });
    }
  }
  const remainder = allTrials.length % trialSize;
  return { sets, remainder, totalTrials: allTrials.length };
}

/* ── TrialTracker component ── */
function TrialTracker({ form, setF, student, goal, sessions }) {
  const trials = form.trials || [];
  const trialSize = goal?.trialSize || student?.trialSize || 5;

  // How many trials already carried over from previous sessions (for this specific goal)
  const goalId = goal?.id;
  const { remainder: carryover, totalTrials: prevTotal } = useMemo(() => {
    const prevSessions = sessions.filter(s =>
      s.studentId === student.id && s.goalData?.trials?.length > 0 &&
      (!goalId || !s.goalData?.goalId || s.goalData.goalId === goalId)
    );
    return groupTrialsIntoSets(prevSessions, student.id, trialSize);
  }, [sessions, student.id, trialSize, goalId]);

  const addTrial = (type) => setF("trials", [...trials, type]);
  const removeLast = () => setF("trials", trials.slice(0, -1));

  // Combine carryover position + current session trials to show grouping
  const totalSoFar = carryover + trials.length;
  const posInCurrentSet = carryover % trialSize; // where in the set we started this session

  // Which trials complete a full set this session?
  const completedSets = [];
  let buf = [];
  let pos = posInCurrentSet;
  trials.forEach((t, i) => {
    buf.push(t);
    pos++;
    if (pos === trialSize) {
      // Need to reconstruct the full set — first (trialSize - buf.length + buf.length) but actually
      // the set may have started in a previous session
      completedSets.push({ trials: buf.slice(), complete: true });
      buf = [];
      pos = 0;
    }
  });
  const remainder = buf; // incomplete set trials this session

  const correct = trials.filter(t => t === "C").length;
  const incorrect = trials.filter(t => t === "I").length;

  // Show the current position in the active set visually
  const activePosStart = posInCurrentSet; // how many slots filled before this session
  const activeSlots = trialSize;

  return (
    <div>
      {/* Carryover info */}
      {carryover > 0 && (
        <div style={{ fontSize:12, color:"var(--txt2)", background:"var(--inp)", borderRadius:8, padding:"7px 11px", marginBottom:10, display:"flex", alignItems:"center", gap:6 }}>
          <span>↩</span>
          <span><strong>{carryover}</strong> trial{carryover !== 1 ? "s" : ""} carried over from previous sessions — need <strong>{trialSize - carryover}</strong> more to complete this set</span>
        </div>
      )}

      {/* Big tap buttons */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
        <button
          onClick={() => addTrial("C")}
          style={{ padding:"18px 0", borderRadius:12, border:"none", background:"var(--grn)", color:"#fff", fontSize:17, fontWeight:700, cursor:"pointer", boxShadow:"0 4px 14px rgba(31,110,74,.3)", fontFamily:"inherit", transition:"transform .1s, box-shadow .1s" }}
          onMouseDown={e => e.currentTarget.style.transform="scale(.96)"}
          onMouseUp={e => e.currentTarget.style.transform="scale(1)"}
        >
          ✅ Correct
        </button>
        <button
          onClick={() => addTrial("I")}
          style={{ padding:"18px 0", borderRadius:12, border:"none", background:"var(--red)", color:"#fff", fontSize:17, fontWeight:700, cursor:"pointer", boxShadow:"0 4px 14px rgba(184,50,50,.3)", fontFamily:"inherit", transition:"transform .1s, box-shadow .1s" }}
          onMouseDown={e => e.currentTarget.style.transform="scale(.96)"}
          onMouseUp={e => e.currentTarget.style.transform="scale(1)"}
        >
          ❌ Incorrect
        </button>
      </div>

      {/* Trial dots showing current set */}
      {(trials.length > 0 || carryover > 0) && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:11, fontWeight:600, color:"var(--txt2)", textTransform:"uppercase", letterSpacing:".04em", marginBottom:7 }}>
            Active Set ({trialSize} trials)
          </div>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:8 }}>
            {/* Filled slots from previous sessions (greyed out) */}
            {Array.from({ length: activePosStart }).map((_, i) => (
              <div key={"prev-"+i} style={{ width:32, height:32, borderRadius:"50%", background:"#d4e4dc", display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, opacity:.5 }} title="From previous session">•</div>
            ))}
            {/* Current session trials */}
            {trials.slice(-(trialSize - activePosStart > 0 ? trialSize - activePosStart : trialSize)).map((t, i) => (
              <div key={"cur-"+i} style={{ width:32, height:32, borderRadius:"50%", background: t === "C" ? "#d1f5e5" : "#fde0e0", border: t === "C" ? "2px solid var(--grn)" : "2px solid var(--red)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>
                {t === "C" ? "✓" : "✗"}
              </div>
            ))}
            {/* Empty remaining slots */}
            {Array.from({ length: Math.max(0, trialSize - activePosStart - Math.min(trials.length, trialSize - activePosStart)) }).map((_, i) => (
              <div key={"empty-"+i} style={{ width:32, height:32, borderRadius:"50%", border:"2px dashed #d4e4dc", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, color:"#d4e4dc" }}>?</div>
            ))}
          </div>

          {/* Completed sets this session */}
          {completedSets.length > 0 && (
            <div style={{ marginBottom:8 }}>
              {completedSets.map((set, si) => {
                const setCorrect = set.trials.filter(t => t === "C").length;
                const pct = Math.round((setCorrect / trialSize) * 100);
                return (
                  <div key={si} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 11px", background: pct >= 80 ? "#d1f5e5" : "#fde0e0", borderRadius:8, marginBottom:5 }}>
                    <span style={{ fontSize:13, fontWeight:700, color: pct >= 80 ? "var(--grn)" : "var(--red)" }}>{pct}%</span>
                    <div style={{ display:"flex", gap:3 }}>
                      {set.trials.map((t, ti) => (
                        <span key={ti} style={{ fontSize:13 }}>{t === "C" ? "✓" : "✗"}</span>
                      ))}
                    </div>
                    <span style={{ fontSize:11, color:"var(--txt2)", marginLeft:"auto" }}>Set complete ✓</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {trials.length > 0 && (
        <div style={{ background:"var(--inp)", borderRadius:9, padding:"9px 13px", fontSize:13, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span>This session: <strong>{correct}</strong>✅ <strong>{incorrect}</strong>❌</span>
          <button onClick={removeLast} style={{ fontSize:12, color:"var(--txt2)", background:"none", border:"1px solid var(--bdr)", borderRadius:6, padding:"3px 8px", cursor:"pointer" }}>↩ Undo last</button>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════
   TRACKING PAGE
══════════════════════════════════════ */
function TrackingPage({ students, groups, sessions, saveSession, saveGroupSession, deleteSession, toggleDocumented }) {
  const [trackMode, setTrackMode] = useState("individual"); // "individual" | "group"
  const [form, setForm] = useState({ studentId:"", groupId:"", goalId:"", date:todayStr(), directMinutes:"", indirectMinutes:"", notes:"", correct:"", incorrect:"", rubricScore:"", pmScore:"", trials:[], documented: null });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filterStudent, setFilterStudent] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [expandedSession, setExpandedSession] = useState(null);

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const selectedStudent = trackMode === "individual" ? students.find(s => s.id === form.studentId) : null;
  const studentGoals = selectedStudent ? getStudentGoals(selectedStudent) : [];
  const selectedGoal = studentGoals.find(g => g.id === form.goalId) || (studentGoals.length === 1 ? studentGoals[0] : null);

  const monthMinutes = useMemo(() => {
    if (trackMode !== "individual" || !form.studentId || !form.date) return null;
    return minutesUsedInMonth(sessions, form.studentId, form.date.slice(0, 7));
  }, [trackMode, form.studentId, form.date, sessions]);

  const handleSubmit = async () => {
    const isGroup = trackMode === "group";
    if (isGroup && !form.groupId) return;
    if (!isGroup && !form.studentId) return;
    if (!form.date) return;
    setSaving(true);
    const sessionBase = {
      date: form.date,
      directMinutes: Number(form.directMinutes) || 0,
      indirectMinutes: Number(form.indirectMinutes) || 0,
      notes: form.notes,
      documented: form.documented === true,
      goalData: {
        goalId: selectedGoal?.id || undefined,
        trials: form.trials && form.trials.length > 0 ? form.trials : undefined,
        correct: form.trials ? form.trials.filter(t => t === "C").length : (form.correct !== "" ? Number(form.correct) : undefined),
        incorrect: form.trials ? form.trials.filter(t => t === "I").length : (form.incorrect !== "" ? Number(form.incorrect) : undefined),
        rubricScore: form.rubricScore || undefined,
        pmScore: form.pmScore !== "" && form.pmScore !== undefined ? Number(form.pmScore) : undefined,
      }
    };
    if (isGroup) {
      const grp = groups.find(g => g.id === form.groupId);
      if (grp) await saveGroupSession(grp, sessionBase);
    } else {
      await saveSession({ ...sessionBase, id: uid(), studentId: form.studentId });
    }
    setSaving(false);
    setSaved(true); setTimeout(() => setSaved(false), 2500);
    setForm(f => ({ ...f, directMinutes:"", indirectMinutes:"", notes:"", correct:"", incorrect:"", rubricScore:"", pmScore:"", trials:[], documented: null })); // keep studentId, goalId, date
  };

  const visibleSessions = useMemo(() => {
    let s = [...sessions].sort((a, b) => b.date.localeCompare(a.date));
    if (filterStudent) s = s.filter(x => x.studentId === filterStudent);
    if (sessionSearch.trim()) {
      const q = sessionSearch.toLowerCase();
      s = s.filter(x => {
        const st = students.find(st2 => st2.id === x.studentId);
        return (st && st.name.toLowerCase().includes(q)) ||
               (x.notes && x.notes.toLowerCase().includes(q)) ||
               (x.date && x.date.includes(sessionSearch.trim())) ||
               (x.groupName && x.groupName.toLowerCase().includes(q));
      });
    }
    return s.slice(0, 60);
  }, [sessions, filterStudent, sessionSearch, students]);

  return (
    <div className="track-grid" style={{ display:"grid", gridTemplateColumns:"420px 1fr", gap:18, alignItems:"start", width:"100%" }}>
      <div className="card">
        <div className="ch">
          <span className="ct">Log Session</span>
          {saved && <span className="bdg bdg-g">✓ Saved</span>}
        </div>
        <div className="cb">
          {/* Mode toggle */}
          <div className="fg">
            <div style={{ display:"flex", gap:8, marginBottom:2 }}>
              <button
                onClick={() => { setTrackMode("individual"); setF("groupId",""); }}
                style={{ flex:1, padding:"9px 0", borderRadius:9, border:"2px solid", fontFamily:"inherit", cursor:"pointer", fontSize:13, fontWeight:600, transition:"all .15s",
                  borderColor: trackMode==="individual" ? "var(--pri)" : "var(--bdr)",
                  background: trackMode==="individual" ? "var(--pri)" : "var(--inp)",
                  color: trackMode==="individual" ? "#fff" : "var(--txt2)" }}>
                👤 Individual
              </button>
              <button
                onClick={() => { setTrackMode("group"); setF("studentId",""); }}
                style={{ flex:1, padding:"9px 0", borderRadius:9, border:"2px solid", fontFamily:"inherit", cursor:"pointer", fontSize:13, fontWeight:600, transition:"all .15s",
                  borderColor: trackMode==="group" ? "#7c3aed" : "var(--bdr)",
                  background: trackMode==="group" ? "#7c3aed" : "var(--inp)",
                  color: trackMode==="group" ? "#fff" : "var(--txt2)" }}>
                👥 Group
              </button>
            </div>
          </div>

          {trackMode === "individual" ? (
            <div className="fg">
              <label className="fl">Student</label>
              <select className="fc" value={form.studentId} onChange={e => { setF("studentId", e.target.value); setF("goalId",""); setF("trials",[]); }}>
                <option value="">Select student...</option>
                {students.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          ) : (
            <div className="fg">
              <label className="fl">Group</label>
              <select className="fc" value={form.groupId} onChange={e => setF("groupId", e.target.value)}>
                <option value="">Select group...</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({(g.memberIds||[]).length} students)</option>)}
              </select>
              {form.groupId && (() => {
                const grp = groups.find(g => g.id === form.groupId);
                if (!grp) return null;
                return (
                  <div style={{ fontSize:12, color:"#7c3aed", marginTop:5, padding:"7px 10px", background:"#f0eaff", borderRadius:8, display:"flex", flexWrap:"wrap", gap:5 }}>
                    {(grp.memberIds||[]).map(mid => {
                      const st = students.find(s => s.id === mid);
                      return st ? <span key={mid} style={{ background:"#fff", border:"1px solid #c4a8f5", borderRadius:5, padding:"1px 7px", fontSize:11.5 }}>{st.name}</span> : null;
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Goal selector — shown when student has multiple goals */}
          {selectedStudent && studentGoals.length > 1 && (
            <div className="fg">
              <label className="fl">Goal <span style={{ fontWeight:400, textTransform:"none", letterSpacing:0, color:"var(--txt2)", fontSize:11 }}>(optional)</span></label>
              <select className="fc" value={form.goalId} onChange={e => { setF("goalId", e.target.value); setF("trials",[]); }}>
                <option value="">— No specific goal —</option>
                {studentGoals.map((g,i) => (
                  <option key={g.id} value={g.id}>Goal {i+1}: {g.description ? (g.description.length>50?g.description.slice(0,50)+"…":g.description) : g.goalType}</option>
                ))}
              </select>
            </div>
          )}
          {selectedStudent && studentGoals.length === 0 && (
            <div style={{ fontSize:12.5, color:"var(--ora)", padding:"8px 11px", background:"#fef6cd", borderRadius:8, marginBottom:10 }}>
              ⚠ No goals set for this student. Add goals in Manage Students.
            </div>
          )}

          <div className="fg">
            <label className="fl">Date</label>
            <input type="date" className="fc" value={form.date} onChange={e => setF("date", e.target.value)} />
          </div>
          {monthMinutes && selectedStudent && (
            <div className="alert-i">
              <strong>{form.date.slice(0,7) === nowYM() ? "This month" : form.date.slice(0,7)}:</strong>{" "}
              Direct {monthMinutes.direct}/{selectedStudent.directMinutesPerMonth}m · Indirect {monthMinutes.indirect}/{selectedStudent.indirectMinutesPerMonth}m
            </div>
          )}
          <div className="fr">
            <div className="fg">
              <label className="fl">Direct Minutes</label>
              <input type="number" className="fc" min="0" placeholder="0" value={form.directMinutes} onChange={e => setF("directMinutes", e.target.value)} />
            </div>
            <div className="fg">
              <label className="fl">Indirect Minutes</label>
              <input type="number" className="fc" min="0" placeholder="0" value={form.indirectMinutes} onChange={e => setF("indirectMinutes", e.target.value)} />
            </div>
          </div>
          <div className="fg">
            <label className="fl">Session Notes</label>
            <textarea className="fc" placeholder="Observations, progress, next steps..." value={form.notes} onChange={e => setF("notes", e.target.value)} />
          </div>
          {selectedStudent && (
            <>
              <div className="div" />
              <div className="sec">Goal Tracking</div>
              {selectedGoal?.description && (
                <div style={{ fontSize:12.5, color:"#547060", padding:"8px 11px", background:"#edf4f0", borderRadius:8, marginBottom:11, lineHeight:1.55 }}>
                  🎯 {selectedGoal.description}
                </div>
              )}
              {selectedGoal?.goalType === "trials" && (
                <TrialTracker
                  form={form}
                  setF={setF}
                  student={selectedStudent}
                  goal={selectedGoal}
                  sessions={sessions}
                />
              )}
              {selectedGoal?.goalType === "rubric" && (selectedGoal?.rubricLevels||[]).length > 0 && (
                <div className="fg">
                  <label className="fl">📊 Rubric Score</label>
                  <select className="fc" value={form.rubricScore} onChange={e => setF("rubricScore", e.target.value)}>
                    <option value="">Select a level...</option>
                    {(selectedGoal?.rubricLevels||[]).map((lvl, i) => (
                      <option key={i} value={lvl}>{lvl}</option>
                    ))}
                  </select>
                </div>
              )}
              {selectedGoal?.goalType === "pm" && (
                <div className="fg">
                  <label className="fl">📏 Progress Monitoring Score</label>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <input type="number" className="fc" placeholder="Enter score..." value={form.pmScore||""} onChange={e => setF("pmScore", e.target.value)} style={{ flex:1 }} />
                    {form.pmScore && <span style={{ fontSize:28, fontWeight:700, fontFamily:"Lora,serif", color:"var(--pri)", minWidth:60, textAlign:"center" }}>{form.pmScore}</span>}
                  </div>
                  {selectedGoal?.pmGoalScore && (
                    <div style={{ fontSize:12, color:"var(--txt2)", marginTop:5 }}>
                      Goal score: <strong>{selectedGoal.pmGoalScore}</strong>
                      {form.pmScore && <span style={{ marginLeft:8, color: Number(form.pmScore) >= Number(selectedGoal.pmGoalScore) ? "var(--grn)" : "var(--ora)" }}>
                        {Number(form.pmScore) >= Number(selectedGoal.pmGoalScore) ? "✅ Goal met!" : `${(Number(selectedGoal.pmGoalScore) - Number(form.pmScore)).toFixed(1)} away from goal`}
                      </span>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          <div className="div" />
          <div className="fg">
            <label className="fl">📋 Was this session documented?</label>
            <div style={{ display:"flex", gap:10, marginTop:2 }}>
              <button
                onClick={() => setF("documented", form.documented === true ? null : true)}
                style={{
                  flex:1, padding:"10px 0", borderRadius:9, border:"2px solid",
                  borderColor: form.documented === true ? "var(--grn)" : "var(--bdr)",
                  background: form.documented === true ? "#d1f5e5" : "var(--inp)",
                  color: form.documented === true ? "var(--grn)" : "var(--txt2)",
                  fontWeight:600, fontSize:13.5, cursor:"pointer", transition:"all .15s", fontFamily:"inherit"
                }}>
                ✅ Yes, documented
              </button>
              <button
                onClick={() => setF("documented", form.documented === false ? null : false)}
                style={{
                  flex:1, padding:"10px 0", borderRadius:9, border:"2px solid",
                  borderColor: form.documented === false ? "#7c3aed" : "var(--bdr)",
                  background: form.documented === false ? "#f0eaff" : "var(--inp)",
                  color: form.documented === false ? "#7c3aed" : "var(--txt2)",
                  fontWeight:600, fontSize:13.5, cursor:"pointer", transition:"all .15s", fontFamily:"inherit"
                }}>
                ⬜ Not yet
              </button>
            </div>
            {form.documented === false && (
              <div style={{ fontSize:11.5, color:"#7c3aed", marginTop:6, padding:"6px 10px", background:"#f0eaff", borderRadius:7 }}>
                This session will appear in the documentation reminder on the Services page.
              </div>
            )}
            {form.documented === null && (
              <div style={{ fontSize:11.5, color:"var(--txt2)", marginTop:5 }}>
                If left blank, session will be marked as not yet documented.
              </div>
            )}
          </div>
          <button className="btn btn-p" style={{ width:"100%", justifyContent:"center", marginTop:6 }} onClick={handleSubmit} disabled={(trackMode==="individual" ? !form.studentId : !form.groupId) || saving}>
            {saving ? "Saving…" : "＋ Log Session"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="ch">
          <span className="ct">Session Log</span>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <div style={{ position:"relative", display:"inline-flex", alignItems:"center" }}>
              <span style={{ position:"absolute", left:9, fontSize:13, opacity:.45, pointerEvents:"none" }}>&#x1F50D;</span>
              <input className="fc"
                style={{ paddingLeft:30, padding:"5px 9px 5px 30px", fontSize:13, width:210 }}
                placeholder="Search name, notes, date..."
                value={sessionSearch}
                onChange={e => setSessionSearch(e.target.value)} />
            </div>
            {sessionSearch && (
              <button onClick={() => setSessionSearch("")}
                style={{ background:"none", border:"none", cursor:"pointer", fontSize:18, color:"var(--txt2)", padding:"0 4px", lineHeight:1 }}>x</button>
            )}
            <span className="sm muted">{sessions.length} total</span>
            {sessions.filter(s => !s.documented && (!filterStudent || s.studentId === filterStudent)).length > 0 && (
              <span style={{ fontSize:11, background:"#f0eaff", color:"#5b21b6", padding:"2px 8px", borderRadius:8, fontWeight:500 }}>
                {sessions.filter(s => !s.documented && (!filterStudent || s.studentId === filterStudent)).length} undocumented
              </span>
            )}
          </div>
        </div>
        {visibleSessions.length === 0 ? (
          <div className="empty"><div className="empty-i">📋</div><p>No sessions logged yet.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Student</th><th>Date</th><th>Direct</th><th className="hide-mob">Indirect</th><th className="hide-mob">Goal</th><th>Notes</th><th>Doc</th><th></th>
              </tr></thead>
              <tbody>
                {visibleSessions.map(s => {
                  const st = students.find(x => x.id === s.studentId);
                  const gd = s.goalData;
                  const goalStr = gd?.pmScore !== undefined ? `📏 ${gd.pmScore}` : gd?.rubricScore ? `📊 ${gd.rubricScore}` : (gd?.correct !== undefined ? `✅ ${gd.correct}  ❌ ${gd.incorrect ?? 0}` : "—");
                  const isExpanded = expandedSession === s.id;
                  const trialArr = gd?.trials;
                  return (
                    <React.Fragment key={s.id}>
                      <tr
                        onClick={() => setExpandedSession(isExpanded ? null : s.id)}
                        style={{ cursor:"pointer", background: isExpanded ? "#f0f7f4" : (s.documented ? undefined : "rgba(240,234,255,.35)"),
                          borderBottom: isExpanded ? "none" : undefined }}
                      >
                        <td>
                          <strong>{st?.name || "Unknown"}</strong>
                          {s.groupName && <div style={{ fontSize:10.5, color:"#7c3aed", marginTop:1 }}>👥 {s.groupName}</div>}
                        </td>
                        <td style={{ whiteSpace:"nowrap" }}>{s.date}</td>
                        <td>{s.directMinutes}m</td>
                        <td className="hide-mob">{s.indirectMinutes}m</td>
                        <td className="hide-mob" style={{ fontSize:12 }}>{goalStr}</td>
                        <td style={{ maxWidth:160, fontSize:12, color:"#547060" }}>
                          {s.notes ? (s.notes.length > 40 ? s.notes.slice(0,40)+"…" : s.notes) : <span className="muted">—</span>}
                        </td>
                        <td style={{ textAlign:"center" }} onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => toggleDocumented(s)}
                            title={s.documented ? "Mark as undocumented" : "Mark as documented"}
                            style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, lineHeight:1, padding:"2px 6px", borderRadius:6 }}
                          >
                            {s.documented ? "✅" : "⬜"}
                          </button>
                        </td>
                        <td style={{ fontSize:14, color:"var(--txt2)", textAlign:"center" }}>{isExpanded ? "▲" : "▼"}</td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background:"#f0f7f4" }}>
                          <td colSpan={8} style={{ padding:"14px 18px 16px", borderBottom:"2px solid var(--bdr)" }}>
                            <div style={{ display:"flex", flexWrap:"wrap", gap:20 }}>
                              {/* Minutes */}
                              <div>
                                <div style={{ fontSize:11, fontWeight:600, color:"var(--txt2)", textTransform:"uppercase", letterSpacing:".04em", marginBottom:5 }}>Minutes</div>
                                <div style={{ display:"flex", gap:12 }}>
                                  <span style={{ fontSize:14 }}>🕐 Direct: <strong>{s.directMinutes}m</strong></span>
                                  <span style={{ fontSize:14 }}>📋 Indirect: <strong>{s.indirectMinutes}m</strong></span>
                                </div>
                              </div>
                              {/* Goal data */}
                              {gd && (gd.pmScore !== undefined || gd.rubricScore || gd.correct !== undefined || trialArr?.length > 0) && (
                                <div>
                                  <div style={{ fontSize:11, fontWeight:600, color:"var(--txt2)", textTransform:"uppercase", letterSpacing:".04em", marginBottom:5 }}>Goal Data</div>
                                  {trialArr?.length > 0 ? (
                                    <div>
                                      <div style={{ display:"flex", gap:3, flexWrap:"wrap", marginBottom:4 }}>
                                        {trialArr.map((t, ti) => (
                                          <span key={ti} style={{ width:24, height:24, borderRadius:"50%", background: t==="C"?"#d1f5e5":"#fde0e0", border: t==="C"?"1.5px solid var(--grn)":"1.5px solid var(--red)", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color: t==="C"?"var(--grn)":"var(--red)" }}>{t==="C"?"✓":"✗"}</span>
                                        ))}
                                      </div>
                                      <div style={{ fontSize:13, color:"var(--txt2)" }}>
                                        {trialArr.filter(t=>t==="C").length}/{trialArr.length} correct ({Math.round(trialArr.filter(t=>t==="C").length/trialArr.length*100)}%)
                                      </div>
                                    </div>
                                  ) : gd.rubricScore ? (
                                    <span className="bdg bdg-r" style={{ fontSize:13 }}>📊 {gd.rubricScore}</span>
                                  ) : gd.pmScore !== undefined ? (
                                    <span style={{ fontSize:16, fontWeight:700, color:"var(--pri)" }}>📏 {gd.pmScore}</span>
                                  ) : (
                                    <span style={{ fontSize:13 }}>✅ {gd.correct} correct · ❌ {gd.incorrect ?? 0} incorrect</span>
                                  )}
                                </div>
                              )}
                              {/* Notes */}
                              <div style={{ flex:1, minWidth:200 }}>
                                <div style={{ fontSize:11, fontWeight:600, color:"var(--txt2)", textTransform:"uppercase", letterSpacing:".04em", marginBottom:5 }}>Notes</div>
                                <div style={{ fontSize:14, color:"var(--txt)", lineHeight:1.6, background:"#fff", padding:"10px 13px", borderRadius:9, border:"1px solid var(--bdr)", whiteSpace:"pre-wrap" }}>
                                  {s.notes || <span style={{ color:"var(--txt2)", fontStyle:"italic" }}>No notes recorded.</span>}
                                </div>
                              </div>
                            </div>
                            {/* Actions */}
                            <div style={{ display:"flex", gap:8, marginTop:12, justifyContent:"flex-end" }}>
                              <button className="btn btn-g btn-sm" onClick={() => toggleDocumented(s)}>
                                {s.documented ? "⬜ Mark undocumented" : "✅ Mark documented"}
                              </button>
                              <button className="btn btn-d btn-sm" onClick={() => { if(confirm("Delete this session?")) { deleteSession(s.id); setExpandedSession(null); } }}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════
   SERVICES PAGE
══════════════════════════════════════ */
function ServicesPage({ students, sessions }) {
  const [selMonth, setSelMonth] = useState(nowYM());
  const [svcSearch, setSvcSearch] = useState("");
  const months = getYMOptions();
  const isCurrentMonth = selMonth === nowYM();

  const data = useMemo(() => students.map(st => {
    const used = minutesUsedInMonth(sessions, st.id, selMonth);
    const remD = Math.max(0, st.directMinutesPerMonth - used.direct);
    const remI = Math.max(0, st.indirectMinutesPerMonth - used.indirect);
    const wLeft = weeksLeftInMonth(selMonth);
    const afterW1 = isAfterFirstWeekFor(selMonth);
    const allMet = used.direct >= st.directMinutesPerMonth && used.indirect >= st.indirectMinutesPerMonth;
    const isOrange = isCurrentMonth && afterW1 && !allMet && ((remD / wLeft) > 30 || (remI / wLeft) > 30);
    return { ...st, used, remD, remI, allMet, isOrange };
  }), [students, sessions, selMonth, isCurrentMonth]);
  const filteredSvcData = useMemo(() => svcSearch.trim() ? data.filter(d => d.name.toLowerCase().includes(svcSearch.toLowerCase())) : data, [data, svcSearch]);

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18, flexWrap:"wrap" }}>
        <select className="fc" style={{ width:210, flex:"0 0 auto" }} value={selMonth} onChange={e => setSelMonth(e.target.value)}>
          {months.map(ym => <option key={ym} value={ym}>{ymLabel(ym)}{ym === nowYM() ? " (Current)" : ""}</option>)}
        </select>
        <div style={{ position:"relative", flex:1, minWidth:150 }}>
          <span style={{ position:"absolute", left:11, top:"50%", transform:"translateY(-50%)", fontSize:14, pointerEvents:"none", opacity:.5 }}>&#128269;</span>
          <input className="fc" style={{ paddingLeft:33 }} placeholder="Search students..." value={svcSearch} onChange={e => setSvcSearch(e.target.value)} />
        </div>
        {svcSearch && <button onClick={() => setSvcSearch("")} style={{ background:"none", border:"none", cursor:"pointer", fontSize:20, color:"var(--txt2)", padding:"0 2px", lineHeight:1 }}>x</button>}
      </div>
      <div className="sg">
        <div className="sc"><div className="sl">Total Students</div><div className="sv">{data.length}</div></div>
        <div className="sc"><div className="sl">Services Met</div><div className="sv" style={{ color:"var(--grn)" }}>{data.filter(d=>d.allMet).length}</div></div>
        <div className="sc"><div className="sl">In Progress</div><div className="sv">{data.filter(d=>!d.allMet).length}</div></div>
        <div className="sc"><div className="sl">Needs Attention</div><div className="sv" style={{ color:"var(--ora)" }}>{data.filter(d=>d.isOrange).length}</div></div>
        <div className="sc"><div className="sl">Undocumented</div><div className="sv" style={{ color:"#7c3aed" }}>{sessions.filter(s=>!s.documented && s.date.startsWith(selMonth)).length}</div></div>
      </div>
      <div style={{ display:"flex", gap:10, marginBottom:13, flexWrap:"wrap" }}>
        <span className="bdg bdg-g">● Services Met</span>
        <span className="bdg bdg-o">● Behind — &gt;30 min/week remaining after week 1</span>
      </div>

      {/* 8-week PM reminders */}
      {(() => {
        const pmStudents = students.filter(s => getStudentGoals(s).some(g => g.goalType === "pm"));
        const getPmGoal = (s) => getStudentGoals(s).find(g => g.goalType === "pm");
        const overdue = pmStudents.filter(s => {
          const g = getPmGoal(s); if (!g) return false;
          if (!g.lastPmDate) return true;
          const days = Math.round((new Date() - new Date(g.lastPmDate + "T00:00:00")) / 86400000);
          return days >= 56;
        });
        const dueSoon = pmStudents.filter(s => {
          const g = getPmGoal(s); if (!g || !g.lastPmDate) return false;
          const days = Math.round((new Date() - new Date(g.lastPmDate + "T00:00:00")) / 86400000);
          return days >= 49 && days < 56;
        });
        if (overdue.length === 0 && dueSoon.length === 0) return null;
        return (
          <div style={{ marginBottom:16 }}>
            {overdue.length > 0 && (
              <div style={{ background:"#fde0e0", border:"1.5px solid #f5b8b8", borderRadius:10, padding:"11px 15px", marginBottom:8 }}>
                <div style={{ fontWeight:600, color:"var(--red)", marginBottom:6, fontSize:13 }}>🔴 Progress Monitoring Overdue (8+ weeks)</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {overdue.map(s => {
                    const g = getPmGoal(s);
                    const days = g?.lastPmDate ? Math.round((new Date() - new Date(g.lastPmDate + "T00:00:00")) / 86400000) : null;
                    return <span key={s.id} className="bdg bdg-rd">{s.name}{days ? ` — ${days}d ago` : " — never monitored"}</span>;
                  })}
                </div>
              </div>
            )}
            {dueSoon.length > 0 && (
              <div style={{ background:"#fef6cd", border:"1.5px solid #f0d060", borderRadius:10, padding:"11px 15px" }}>
                <div style={{ fontWeight:600, color:"var(--yel)", marginBottom:6, fontSize:13 }}>🟡 Progress Monitoring Due Soon (within 1 week)</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {dueSoon.map(s => {
                    const g = getPmGoal(s);
                    const days = g?.lastPmDate ? Math.round((new Date() - new Date(g.lastPmDate + "T00:00:00")) / 86400000) : 0;
                    return <span key={s.id} className="bdg bdg-y">{s.name} — {days}d ago</span>;
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })()}
      {/* Undocumented Sessions Reminder */}
      {(() => {
        const undoc = sessions.filter(s => !s.documented && s.date.startsWith(selMonth));
        if (undoc.length === 0) return null;
        return (
          <div style={{ background:"#f0eaff", border:"1.5px solid #c4a8f5", borderRadius:10, padding:"13px 16px", marginBottom:16 }}>
            <div style={{ fontWeight:600, color:"#5b21b6", marginBottom:8, fontSize:13, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span>📝 Undocumented Sessions — {ymLabel(selMonth)}</span>
              <span style={{ fontSize:12, fontWeight:500, color:"#7c3aed" }}>{undoc.length} session{undoc.length !== 1 ? "s" : ""} need documentation</span>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {undoc.sort((a,b) => a.date.localeCompare(b.date)).map(s => {
                const st = students.find(x => x.id === s.studentId);
                return (
                  <div key={s.id} style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(255,255,255,.6)", borderRadius:8, padding:"8px 10px", flexWrap:"wrap" }}>
                    <span style={{ fontSize:18, cursor:"pointer" }} onClick={() => {
                      // Mark as documented inline
                      const evt = new CustomEvent("toggleDoc", { detail: s });
                      window.dispatchEvent(evt);
                    }}>⬜</span>
                    <div style={{ flex:1 }}>
                      <strong style={{ fontSize:13 }}>{st?.name || "Unknown"}</strong>
                      <span style={{ fontSize:12, color:"#7c3aed", marginLeft:8 }}>{s.date}</span>
                      <span style={{ fontSize:12, color:"#6d28d9", marginLeft:8 }}>Direct: {s.directMinutes}m · Indirect: {s.indirectMinutes}m</span>
                    </div>
                    {s.notes && <span style={{ fontSize:11, color:"#7c3aed", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.notes}</span>}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize:11, color:"#7c3aed", marginTop:8, opacity:.7 }}>💡 Check off sessions in the Tracking page to mark them as documented.</div>
          </div>
        );
      })()}

      <div className="card">
        {data.length === 0 ? (
          <div className="empty"><div className="empty-i">⏱️</div><p>No students yet.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl svc-tbl">
              <thead><tr>
                <th>Student</th>
                <th className="hide-mob">Direct Used</th><th>Direct Left</th><th className="hide-mob">Progress</th>
                <th className="hide-mob">Indirect Used</th><th>Indir. Left</th><th className="hide-mob">Progress</th>
                <th>Status</th>
              </tr></thead>
              <tbody>
                {filteredSvcData.length === 0 && svcSearch ? (<tr><td colSpan={8} style={{ textAlign:"center", padding:"22px", color:"var(--txt2)", fontStyle:"italic" }}>No students match your search</td></tr>) : null}{filteredSvcData.map(d => {
                  const dPct = Math.min(100, (d.used.direct / Math.max(1, d.directMinutesPerMonth)) * 100);
                  const iPct = Math.min(100, (d.used.indirect / Math.max(1, d.indirectMinutesPerMonth)) * 100);
                  return (
                    <tr key={d.id} className={d.allMet ? "rg" : d.isOrange ? "ro" : ""}>
                      <td style={{ whiteSpace:"nowrap" }}><strong style={{ fontWeight: d.isOrange ? 700 : 500 }}>{d.name}</strong>{d.grade && <span className="hide-mob" style={{ fontSize:11, color:"var(--txt2)" }}> · {d.grade}</span>}{d.studentType && d.studentType!=="IEP" && <span className={`bdg ${d.studentType==="504"?"bdg-a":""}`} style={{ marginLeft:5, fontSize:10, ...(d.studentType==="GenEd"?{background:"#f0eaff",color:"#7c3aed"}:{}) }}>{d.studentType}</span>}</td>
                      <td className="hide-mob">{d.used.direct}<span className="muted sm">/{d.directMinutesPerMonth}m</span></td>
                      <td><strong>{d.remD}m</strong></td>
                      <td className="hide-mob">
                        <div className="pw"><div className="pb" style={{ width:`${dPct}%`, background:dPct>=100?"var(--grn)":"var(--pri)" }} /></div>
                        <span style={{ fontSize:10, color:"var(--txt2)" }}>{Math.round(dPct)}%</span>
                      </td>
                      <td className="hide-mob">{d.used.indirect}<span className="muted sm">/{d.indirectMinutesPerMonth}m</span></td>
                      <td><strong>{d.remI}m</strong></td>
                      <td>
                        <div className="pw"><div className="pb" style={{ width:`${iPct}%`, background:iPct>=100?"var(--grn)":"var(--pri)" }} /></div>
                        <span style={{ fontSize:10, color:"var(--txt2)" }}>{Math.round(iPct)}%</span>
                      </td>
                      <td>
                        {d.allMet ? <span className="bdg bdg-g">✓ Met</span> : d.isOrange ? <span className="bdg bdg-o">⚠ Behind</span> : <span className="bdg bdg-n">On Track</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════
   MEETINGS PAGE
══════════════════════════════════════ */
function MeetingsPage({ students, saveStudent }) {
  const [schedModal, setSchedModal] = useState(null);
  const [schedDate, setSchedDate] = useState("");
  const [calMonth, setCalMonth] = useState(nowYM());

  const upcoming = useMemo(() => students
    .filter(s => s.meetingDueDate && !s.meetingCompleted)
    .map(s => {
      const days = daysUntil(s.meetingDueDate);
      const isAnnual = s.meetingType === "Annual";
      let hi = "";
      if (isAnnual) { if (days <= 7) hi = "red"; else if (days <= 30) hi = "yellow"; }
      else { if (days <= 60) hi = "red"; else if (days <= 75) hi = "yellow"; }
      return { ...s, days, hi };
    })
    .sort((a, b) => a.days - b.days), [students]);

  const completed = students.filter(s => s.meetingCompleted);
  const markDone = async (id) => { const s = students.find(x => x.id === id); if (s) await saveStudent({ ...s, meetingCompleted: true }); };
  const undoDone = async (id) => { const s = students.find(x => x.id === id); if (s) await saveStudent({ ...s, meetingCompleted: false }); };
  const saveSched = async () => {
    const s = students.find(x => x.id === schedModal);
    if (s) await saveStudent({ ...s, meetingScheduledDate: schedDate });
    setSchedModal(null);
  };

  const rowCls = (hi) => hi === "red" ? "rr" : hi === "yellow" ? "ry" : "";

  return (
    <div>
      <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap" }}>
        <span className="bdg bdg-y">● Annual ≤30 days · Re-eval ≤75 days</span>
        <span className="bdg bdg-rd">● Annual ≤7 days · Re-eval ≤60 days</span>
      </div>
      <div className="sg sg4">
        <div className="sc"><div className="sl">Upcoming</div><div className="sv">{upcoming.length}</div></div>
        <div className="sc"><div className="sl">Urgent 🔴</div><div className="sv" style={{ color:"var(--red)" }}>{upcoming.filter(m=>m.hi==="red").length}</div></div>
        <div className="sc"><div className="sl">Soon 🟡</div><div className="sv" style={{ color:"var(--yel)" }}>{upcoming.filter(m=>m.hi==="yellow").length}</div></div>
        <div className="sc"><div className="sl">Completed ✓</div><div className="sv" style={{ color:"var(--grn)" }}>{completed.length}</div></div>
      </div>
      {/* ── Calendar ── */}
      <div className="card" style={{ marginBottom:18 }}>
        <div className="ch" style={{ flexWrap:"wrap", gap:8 }}>
          <span className="ct">📅 Calendar</span>
          <div className="cal-nav" style={{ display:"flex", alignItems:"center", gap:8, flex:1, justifyContent:"flex-end" }}>
            <button className="btn btn-g btn-sm" onClick={() => {
              const [y,m] = calMonth.split("-").map(Number);
              const d = new Date(y, m-2, 1);
              setCalMonth(d.toISOString().slice(0,7));
            }}>‹</button>
            <span style={{ fontWeight:600, fontSize:13.5, textAlign:"center", flex:1 }}>{ymLabel(calMonth)}</span>
            <button className="btn btn-g btn-sm" onClick={() => {
              const [y,m] = calMonth.split("-").map(Number);
              const d = new Date(y, m, 1);
              setCalMonth(d.toISOString().slice(0,7));
            }}>›</button>
            <button className="btn btn-o btn-sm" onClick={() => setCalMonth(nowYM())}>Today</button>
          </div>
        </div>
        <div className="cb" style={{ padding:"14px 16px" }}>
          {(() => {
            const [y,m] = calMonth.split("-").map(Number);
            const firstDay = new Date(y, m-1, 1).getDay();
            const daysInMonth = new Date(y, m, 0).getDate();
            const todayFull = todayStr();

            // Gather all meetings that fall in this month (due date or scheduled date)
            const meetingsInMonth = students.reduce((acc, s) => {
              if (s.meetingDueDate && s.meetingDueDate.startsWith(calMonth)) {
                acc.push({ ...s, markerDate: s.meetingDueDate, kind:"due" });
              }
              if (s.meetingScheduledDate && s.meetingScheduledDate.startsWith(calMonth)) {
                acc.push({ ...s, markerDate: s.meetingScheduledDate, kind:"sched" });
              }
              return acc;
            }, []);

            const byDay = {};
            meetingsInMonth.forEach(m => {
              const day = parseInt(m.markerDate.split("-")[2]);
              if (!byDay[day]) byDay[day] = [];
              byDay[day].push(m);
            });

            const cells = [];
            // Empty cells before first day
            for (let i = 0; i < firstDay; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) cells.push(d);

            const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

            return (
              <div>
                {/* Day headers */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3, marginBottom:4 }}>
                  {dayNames.map(d => (
                    <div key={d} style={{ textAlign:"center", fontSize:10.5, fontWeight:600, color:"var(--txt2)", padding:"4px 0", textTransform:"uppercase", letterSpacing:".04em" }}>{d}</div>
                  ))}
                </div>
                {/* Calendar grid */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3 }}>
                  {cells.map((day, i) => {
                    if (!day) return <div key={"e"+i} />;
                    const dateStr = `${calMonth}-${String(day).padStart(2,"0")}`;
                    const isToday = dateStr === todayFull;
                    const dayMeetings = byDay[day] || [];
                    return (
                      <div key={day} style={{
                        minHeight:68, borderRadius:8, padding:"5px 5px 4px",
                        background: isToday ? "#e8f5ef" : "var(--inp)",
                        border: isToday ? "2px solid var(--pri)" : "1.5px solid var(--bdr)",
                        position:"relative"
                      }}>
                        <div style={{ fontSize:11.5, fontWeight: isToday ? 700 : 500, color: isToday ? "var(--pri)" : "var(--txt2)", marginBottom:3 }}>{day}</div>
                        {dayMeetings.map((m, mi) => {
                          const days = daysUntil(m.kind === "due" ? m.meetingDueDate : m.meetingScheduledDate);
                          const isAnnual = m.meetingType === "Annual";
                          let bg = "#dbeafe", color = "#1d4ed8";
                          if (m.kind === "due") {
                            if (isAnnual) {
                              if (days <= 7) { bg="#fde0e0"; color="var(--red)"; }
                              else if (days <= 30) { bg="#fef6cd"; color="#9a6800"; }
                            } else {
                              if (days <= 60) { bg="#fde0e0"; color="var(--red)"; }
                              else if (days <= 75) { bg="#fef6cd"; color="#9a6800"; }
                            }
                          } else {
                            bg="#d1f5e5"; color="var(--grn)";
                          }
                          if (m.meetingCompleted) { bg="#f0f0f0"; color="#aaa"; }
                          return (
                            <div key={mi} title={`${m.name} — ${m.kind==="due"?"Due":"Scheduled"} (${m.meetingType})`}
                              style={{ background:bg, color, fontSize:9.5, fontWeight:600, borderRadius:4, padding:"2px 4px", marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", lineHeight:1.4 }}>
                              {m.kind==="sched"?"📅 ":m.hi==="red"?"🔴 ":m.hi==="yellow"?"🟡 ":"🔵 "}{m.name.split(" ")[0]}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
                {/* Legend */}
                <div style={{ display:"flex", gap:12, marginTop:12, flexWrap:"wrap", fontSize:11, color:"var(--txt2)" }}>
                  <span>🔵 Due (ok)</span>
                  <span>🟡 Due soon</span>
                  <span>🔴 Urgent</span>
                  <span>📅 Scheduled date</span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      <div className="card" style={{ marginBottom:18 }}>
        <div className="ch"><span className="ct">Upcoming Meetings</span><span className="sm muted">Sorted by due date</span></div>
        {upcoming.length === 0 ? (
          <div className="empty"><div className="empty-i">📅</div><p>No upcoming meetings.<br />Add students with meeting dates in Manage.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Student</th><th>Type</th><th>Due Date</th><th>Days</th><th className="hide-mob">Scheduled</th><th>Actions</th></tr></thead>
              <tbody>
                {upcoming.map(m => (
                  <tr key={m.id} className={rowCls(m.hi)}>
                    <td><strong>{m.name}</strong>{m.grade && <div style={{ fontSize:11, color:"var(--txt2)" }}>{m.grade}</div>}</td>
                    <td><span className={`bdg ${m.meetingType==="Annual"?"bdg-a":"bdg-r"}`}>{m.meetingType}</span></td>
                    <td>{m.meetingDueDate}</td>
                    <td><span style={{ fontWeight:600, color:m.hi==="red"?"var(--red)":m.hi==="yellow"?"#9a6800":"var(--grn)" }}>
                      {m.days < 0 ? `⚠ ${Math.abs(m.days)}d` : m.days === 0 ? "⚠ Today" : `${m.days}d`}
                    </span></td>
                    <td className="hide-mob">{m.meetingScheduledDate ? <span style={{ color:"var(--grn)", fontWeight:500 }}>📅 {m.meetingScheduledDate}</span> : <span className="sm muted">—</span>}</td>
                    <td>
                      <div style={{ display:"flex", gap:6 }}>
                        <button className="btn btn-o btn-sm" onClick={() => { setSchedModal(m.id); setSchedDate(m.meetingScheduledDate||""); }}>📅 Set Date</button>
                        <button className="btn btn-sm" style={{ background:"#d1f5e5", color:"#065f46" }} onClick={() => markDone(m.id)}>✓ Complete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {completed.length > 0 && (
        <div className="card">
          <div className="ch"><span className="ct" style={{ color:"var(--txt2)" }}>Completed Meetings</span></div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Student</th><th>Type</th><th>Due Date</th><th>Scheduled</th><th></th></tr></thead>
              <tbody>
                {completed.map(s => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong></td>
                    <td><span className={`bdg ${s.meetingType==="Annual"?"bdg-a":"bdg-r"}`}>{s.meetingType}</span></td>
                    <td>{s.meetingDueDate}</td>
                    <td>{s.meetingScheduledDate||"—"}</td>
                    <td><button className="btn btn-g btn-sm" onClick={() => undoDone(s.id)}>↩ Undo</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {schedModal && (
        <div className="mo" onClick={() => setSchedModal(null)}>
          <div className="md" style={{ maxWidth:380 }} onClick={e => e.stopPropagation()}>
            <div className="mh"><span className="mt2">Set Meeting Date</span><button className="xbtn" onClick={() => setSchedModal(null)}>×</button></div>
            <div className="mb2">
              <div className="fg">
                <label className="fl">Meeting Date</label>
                <input type="date" className="fc" value={schedDate} onChange={e => setSchedDate(e.target.value)} />
              </div>
            </div>
            <div className="mf">
              <button className="btn btn-g" onClick={() => setSchedModal(null)}>Cancel</button>
              <button className="btn btn-p" onClick={saveSched}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════
   MANAGE PAGE
══════════════════════════════════════ */
function defaultForm() {
  return { name:"", grade:"", studentType:"IEP", directMinutesPerMonth:"", indirectMinutesPerMonth:"", goals:[], meetingType:"Annual", meetingDueDate:"", meetingScheduledDate:"" };
}
function defaultGoalForm() {
  return { id:"", description:"", goalType:"trials", trialSize:5, rubricLevels:[], pmGoalScore:"", lastPmDate:"" };
}

function ManagePage({ students, groups, sessions, saveStudent, deleteStudent, allStudents }) {
  const [manageTab, setManageTab] = useState("students");
  const [manageSearch, setManageSearch] = useState("");
  const [manageSort, setManageSort] = useState("name-az");
  const [manageFilter, setManageFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(defaultForm());
  const [saving, setSaving] = useState(false);
  // Group state
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editGroupId, setEditGroupId] = useState(null);
  const [groupForm, setGroupForm] = useState({ name:"", memberIds:[] });
  const [savingGroup, setSavingGroup] = useState(false);

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const openAdd = () => { setEditId(null); setForm(defaultForm()); setShowModal(true); };
  const openEdit = (s) => {
    setEditId(s.id);
    // migrate legacy single-goal to goals array
    const goals = getStudentGoals(s);
    setForm({ name:s.name||"", grade:s.grade||"", studentType:s.studentType||"IEP", directMinutesPerMonth:s.directMinutesPerMonth||"", indirectMinutesPerMonth:s.indirectMinutesPerMonth||"", goals, meetingType:s.meetingType||"Annual", meetingDueDate:s.meetingDueDate||"", meetingScheduledDate:s.meetingScheduledDate||"" });
    setShowModal(true);
  };
  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const base = editId ? students.find(s => s.id === editId) : { id:uid(), meetingCompleted:false };
    const student = { ...base, name:form.name, grade:form.grade, studentType:form.studentType||"IEP", directMinutesPerMonth:form.studentType==="GenEd"?0:Number(form.directMinutesPerMonth)||0, indirectMinutesPerMonth:form.studentType==="GenEd"?0:Number(form.indirectMinutesPerMonth)||0, goals:form.studentType==="IEP"?form.goals:[], meetingType:form.meetingType, meetingDueDate:form.meetingDueDate, meetingScheduledDate:form.meetingScheduledDate };
    await saveStudent(student);
    setSaving(false);
    setShowModal(false);
  };

  // Inline goal editing inside modal
  const [editingGoal, setEditingGoal] = useState(null); // null = not editing, or goal object
  const [goalForm, setGF2] = useState(defaultGoalForm());
  const [rubricIn, setRubricIn] = useState("");
  const openAddGoal = () => { setEditingGoal("new"); setGF2({ ...defaultGoalForm(), id: uid() }); setRubricIn(""); };
  const openEditGoal = (g) => { setEditingGoal(g.id); setGF2({ ...g }); setRubricIn(""); };
  const saveGoal = () => {
    if (!goalForm.description.trim() && !goalForm.goalType) return;
    const existing = form.goals || [];
    if (editingGoal === "new") {
      setF("goals", [...existing, goalForm]);
    } else {
      setF("goals", existing.map(g => g.id === editingGoal ? goalForm : g));
    }
    setEditingGoal(null);
  };
  const deleteGoal = (id) => setF("goals", (form.goals||[]).filter(g => g.id !== id));
  const addRubric2 = () => {
    if (!rubricIn.trim()) return;
    setGF2(f => ({ ...f, rubricLevels: [...(f.rubricLevels||[]), rubricIn.trim()] }));
    setRubricIn("");
  };


  const openAddGroup = () => { setEditGroupId(null); setGroupForm({ name:"", memberIds:[] }); setShowGroupModal(true); };
  const openEditGroup = (g) => { setEditGroupId(g.id); setGroupForm({ name:g.name||"", memberIds:g.memberIds||[] }); setShowGroupModal(true); };
  const handleSaveGroup = async () => {
    if (!groupForm.name.trim()) return;
    setSavingGroup(true);
    const base = editGroupId ? groups.find(g => g.id === editGroupId) : { id: uid() };
    await saveStudent({ ...base, ...groupForm, isGroup: true });
    setSavingGroup(false);
    setShowGroupModal(false);
  };
  const toggleMember = (studentId) => {
    setGroupForm(f => ({
      ...f,
      memberIds: f.memberIds.includes(studentId)
        ? f.memberIds.filter(id => id !== studentId)
        : [...f.memberIds, studentId]
    }));
  };

  return (
    <div>
      {/* Tabs */}
      <div style={{ display:"flex", gap:0, marginBottom:18, background:"var(--inp)", borderRadius:10, padding:3, width:"fit-content" }}>
        {[["students","👤 Students"],["groups","👥 Groups"]].map(([id,lbl]) => (
          <button key={id} onClick={() => setManageTab(id)}
            style={{ padding:"7px 20px", borderRadius:8, border:"none", fontFamily:"inherit", fontSize:13, fontWeight:600, cursor:"pointer", transition:"all .15s",
              background: manageTab===id ? "#fff" : "transparent",
              color: manageTab===id ? "var(--txt)" : "var(--txt2)",
              boxShadow: manageTab===id ? "0 1px 4px rgba(0,0,0,.08)" : "none" }}>
            {lbl}
          </button>
        ))}
      </div>

      {manageTab === "students" && (
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:15, flexWrap:"wrap" }}>
        {/* Search */}
        <div style={{ position:"relative", flex:"1 1 160px", minWidth:140 }}>
          <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", fontSize:13, pointerEvents:"none", opacity:.45 }}>&#x1F50D;</span>
          <input className="fc" style={{ paddingLeft:30 }} placeholder="Search..." value={manageSearch} onChange={e => setManageSearch(e.target.value)} />
        </div>
        {manageSearch && <button onClick={() => setManageSearch("")} style={{ background:"none", border:"none", cursor:"pointer", fontSize:18, color:"var(--txt2)", padding:"0 2px" }}>×</button>}
        {/* Filter by type */}
        <select className="fc" style={{ flex:"0 0 auto", width:"auto", minWidth:110 }} value={manageFilter} onChange={e => setManageFilter(e.target.value)}>
          <option value="all">All Types</option>
          <option value="IEP">IEP Only</option>
          <option value="504">504 Only</option>
          <option value="GenEd">Gen Ed Only</option>
        </select>
        {/* Sort */}
        <select className="fc" style={{ flex:"0 0 auto", width:"auto", minWidth:160 }} value={manageSort} onChange={e => setManageSort(e.target.value)}>
          <option value="name-az">Name A → Z</option>
          <option value="name-za">Name Z → A</option>
          <option value="type">By Type</option>
          <option value="due-asc">Due Date (Soonest)</option>
          <option value="due-desc">Due Date (Latest)</option>
          <option value="sessions-desc">Most Sessions</option>
        </select>
        <button className="btn btn-p" onClick={openAdd} style={{ flex:"0 0 auto" }}>+ Add Student</button>
      </div>
      )}
      {manageTab === "groups" && (
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:15 }}>
        <button className="btn btn-p" style={{ background:"#7c3aed" }} onClick={openAddGroup}>＋ Add Group</button>
      </div>
      )}
      {manageTab === "students" && <div className="card">
        {students.length === 0 ? (
          <div className="empty"><div className="empty-i">👥</div><p>No students yet.<br />Click "Add Student" to get started.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th>Name</th><th>Type</th><th>Grade</th><th>Direct/Mo</th><th>Indirect/Mo</th><th>Goal</th><th>Due Date</th><th>Sessions</th><th>Actions</th>
              </tr></thead>
              <tbody>
{(() => {
                  const typeOrder = {"IEP":0,"504":1,"GenEd":2};
                  let rows = students
                    .filter(s => (!manageSearch.trim() || s.name.toLowerCase().includes(manageSearch.toLowerCase()))
                              && (manageFilter==="all" || (s.studentType||"IEP")===manageFilter));
                  rows = [...rows].sort((a,b) => {
                    if (manageSort==="name-az") return a.name.localeCompare(b.name);
                    if (manageSort==="name-za") return b.name.localeCompare(a.name);
                    if (manageSort==="type") return (typeOrder[a.studentType||"IEP"]||0)-(typeOrder[b.studentType||"IEP"]||0);
                    if (manageSort==="due-asc") {
                      const da = a.meetingDueDate||"9999"; const db = b.meetingDueDate||"9999";
                      return da.localeCompare(db);
                    }
                    if (manageSort==="due-desc") {
                      const da = a.meetingDueDate||"0000"; const db = b.meetingDueDate||"0000";
                      return db.localeCompare(da);
                    }
                    if (manageSort==="sessions-desc") return sessions.filter(x=>x.studentId===b.id).length - sessions.filter(x=>x.studentId===a.id).length;
                    return 0;
                  });
                  if (rows.length===0) return <tr><td colSpan={9} style={{ textAlign:"center", padding:"22px", color:"var(--txt2)", fontStyle:"italic" }}>No students match your filters</td></tr>;
                  return rows.map(s => {
                  const days = daysUntil(s.meetingDueDate);
                  const urgent = s.meetingDueDate && !s.meetingCompleted && days <= 30;
                  return (
                    <tr key={s.id}>
                      <td><strong>{s.name}</strong></td>
                      <td>{s.studentType==="504"
                        ? <span className="bdg bdg-a">504</span>
                        : s.studentType==="GenEd"
                        ? <span className="bdg" style={{ background:"#f0eaff", color:"#7c3aed" }}>GenEd</span>
                        : <span className="bdg bdg-g">IEP</span>}
                      </td>
                      <td>{s.grade||"—"}</td>
                      <td>{s.studentType==="GenEd" ? <span className="muted sm">—</span> : <><strong>{s.directMinutesPerMonth}</strong>m</>}</td>
                      <td>{s.studentType==="GenEd" ? <span className="muted sm">—</span> : <><strong>{s.indirectMinutesPerMonth}</strong>m</>}</td>
                      <td>{s.studentType==="IEP" ? (() => { const gs = getStudentGoals(s); return gs.length===0 ? <span className="muted sm">No goals</span> : gs.length===1 ? <span className={`bdg ${gs[0].goalType==="rubric"?"bdg-r":gs[0].goalType==="pm"?"bdg-n":"bdg-a"}`}>{gs[0].goalType==="rubric"?"Rubric":gs[0].goalType==="pm"?"PM":"Trials"}</span> : <span className="bdg bdg-a">{gs.length} goals</span>; })() : <span className="muted sm">—</span>}</td>
                      <td><span style={{ color:urgent?"var(--red)":"var(--txt)", fontWeight:urgent?600:400 }}>{s.meetingDueDate||"—"}{s.meetingCompleted&&<span className="bdg bdg-g" style={{ marginLeft:4 }}>Done</span>}</span></td>
                      <td><span className="bdg bdg-n">{sessions.filter(x=>x.studentId===s.id).length}</span></td>
                      <td>
                        <div style={{ display:"flex", gap:5 }}>
                          <button className="btn btn-o btn-sm" onClick={() => openEdit(s)}>Edit</button>
                          <button className="btn btn-d btn-sm" onClick={() => { if(confirm("Delete student and all their sessions?")) deleteStudent(s.id); }}>Del</button>
                        </div>
                      </td>
                    </tr>
                  );
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>}

      {manageTab === "groups" && (
        <div className="card">
          {groups.length === 0 ? (
            <div className="empty"><div className="empty-i">👥</div><p>No groups yet.<br />Click "Add Group" to create one.</p></div>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr>
                  <th>Group Name</th><th>Members</th><th>Sessions</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  {groups.map(g => {
                    const memberCount = (g.memberIds||[]).length;
                    const groupSessions = sessions.filter(s => s.groupId === g.id);
                    return (
                      <tr key={g.id}>
                        <td><strong style={{ color:"#7c3aed" }}>👥 {g.name}</strong></td>
                        <td>
                          <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                            {(g.memberIds||[]).map(mid => {
                              const st = students.find(s => s.id === mid);
                              return st ? <span key={mid} style={{ fontSize:11.5, background:"#f0eaff", color:"#7c3aed", padding:"1px 7px", borderRadius:5, border:"1px solid #c4a8f5" }}>{st.name}</span> : null;
                            })}
                            {memberCount === 0 && <span className="muted sm">No members</span>}
                          </div>
                        </td>
                        <td><span className="bdg bdg-n">{groupSessions.length} group logs</span></td>
                        <td>
                          <div style={{ display:"flex", gap:5 }}>
                            <button className="btn btn-o btn-sm" onClick={() => openEditGroup(g)}>Edit</button>
                            <button className="btn btn-d btn-sm" onClick={() => { if(confirm("Delete group? (Student records are kept)")) deleteStudent(g.id); }}>Del</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showGroupModal && (
        <div className="mo" onClick={() => setShowGroupModal(false)}>
          <div className="md" style={{ maxWidth:480 }} onClick={e => e.stopPropagation()}>
            <div className="mh">
              <span className="mt2">{editGroupId ? "Edit Group" : "Create Group"}</span>
              <button className="xbtn" onClick={() => setShowGroupModal(false)}>×</button>
            </div>
            <div className="mb2">
              <div className="fg">
                <label className="fl">Group Name</label>
                <input className="fc" placeholder='e.g. "Reading Group A"' value={groupForm.name} onChange={e => setGroupForm(f => ({...f, name:e.target.value}))} />
              </div>
              <div className="div" />
              <div className="sec">Select Members</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:280, overflowY:"auto" }}>
                {students.length === 0 && <p className="muted sm">No students yet — add students first.</p>}
                {students.map(s => {
                  const selected = groupForm.memberIds.includes(s.id);
                  return (
                    <div key={s.id}
                      onClick={() => toggleMember(s.id)}
                      style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", borderRadius:9, cursor:"pointer", border:"1.5px solid", transition:"all .15s",
                        borderColor: selected ? "#7c3aed" : "var(--bdr)",
                        background: selected ? "#f0eaff" : "var(--inp)" }}>
                      <span style={{ fontSize:18 }}>{selected ? "✅" : "⬜"}</span>
                      <div>
                        <div style={{ fontWeight:600, fontSize:13 }}>{s.name}</div>
                        {s.grade && <div style={{ fontSize:11, color:"var(--txt2)" }}>{s.grade}</div>}
                      </div>
                      {selected && <span style={{ marginLeft:"auto", fontSize:11, color:"#7c3aed", fontWeight:600 }}>In group</span>}
                    </div>
                  );
                })}
              </div>
              {groupForm.memberIds.length > 0 && (
                <div style={{ marginTop:10, fontSize:12, color:"#7c3aed", fontWeight:500 }}>
                  {groupForm.memberIds.length} member{groupForm.memberIds.length !== 1 ? "s" : ""} selected
                </div>
              )}
            </div>
            <div className="mf">
              <button className="btn btn-g" onClick={() => setShowGroupModal(false)}>Cancel</button>
              <button className="btn btn-p" style={{ background:"#7c3aed", borderColor:"#7c3aed" }} onClick={handleSaveGroup} disabled={!groupForm.name.trim() || savingGroup}>
                {savingGroup ? "Saving…" : editGroupId ? "Save Changes" : "Create Group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="mo" onClick={() => setShowModal(false)}>
          <div className="md" onClick={e => e.stopPropagation()}>
            <div className="mh">
              <span className="mt2">{editId ? "Edit Student" : "Add New Student"}</span>
              <button className="xbtn" onClick={() => setShowModal(false)}>×</button>
            </div>
            <div className="mb2">
              {/* Student Type Selector */}
              <div className="fg">
                <label className="fl">Student Type</label>
                <div style={{ display:"flex", gap:8 }}>
                  {[["IEP","IEP","#2d7d5e","#edf4f0"],["504","504","#1d4ed8","#dbeafe"],["GenEd","Gen Ed","#7c3aed","#f0eaff"]].map(([val,lbl,col,bg]) => (
                    <button key={val} onClick={() => setF("studentType", val)}
                      style={{ flex:1, padding:"10px 6px", borderRadius:9, border:"2px solid", fontFamily:"inherit", cursor:"pointer", fontSize:14, fontWeight:700, transition:"all .15s",
                        borderColor: form.studentType===val ? col : "var(--bdr)",
                        background: form.studentType===val ? bg : "var(--inp)",
                        color: form.studentType===val ? col : "var(--txt2)" }}>
                      {lbl}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:12, color:"var(--txt2)", marginTop:5 }}>
                  {form.studentType==="IEP" && "IEP students have goals and set service minutes."}
                  {form.studentType==="504" && "504 students have a 504 plan but no IEP goals."}
                  {form.studentType==="GenEd" && "General education students — no goals or set minutes."}
                </div>
              </div>
              <div className="div" />
              <div className="sec">Basic Info</div>
              <div className="fr">
                <div className="fg">
                  <label className="fl">Student Name *</label>
                  <input className="fc" placeholder="Full name" value={form.name} onChange={e => setF("name", e.target.value)} />
                </div>
                <div className="fg">
                  <label className="fl">Grade</label>
                  <input className="fc" placeholder="e.g. 9th, 10th" value={form.grade} onChange={e => setF("grade", e.target.value)} />
                </div>
              </div>
              {form.studentType !== "GenEd" && (<>
              <div className="div" />
              <div className="sec">Service Minutes Per Month</div>
              <div className="fr">
                <div className="fg">
                  <label className="fl">Direct Minutes</label>
                  <input type="number" className="fc" placeholder="e.g. 120" value={form.directMinutesPerMonth} onChange={e => setF("directMinutesPerMonth", e.target.value)} />
                </div>
                <div className="fg">
                  <label className="fl">Indirect Minutes</label>
                  <input type="number" className="fc" placeholder="e.g. 30" value={form.indirectMinutesPerMonth} onChange={e => setF("indirectMinutesPerMonth", e.target.value)} />
                </div>
              </div>
              </>)}
              {form.studentType === "IEP" && (<>
              <div className="div" />
              <div className="sec" style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span>IEP Goals ({(form.goals||[]).length})</span>
                <button className="btn btn-o btn-sm" onClick={openAddGoal} style={{ fontSize:12 }}>+ Add Goal</button>
              </div>

              {/* Goal list */}
              {(form.goals||[]).length === 0 && (
                <div style={{ fontSize:13, color:"var(--txt2)", padding:"10px 0", marginBottom:8 }}>No goals yet — click "Add Goal" to add one.</div>
              )}
              {(form.goals||[]).map((g, gi) => (
                <div key={g.id} style={{ background:"var(--inp)", borderRadius:9, padding:"10px 13px", marginBottom:8, border:"1.5px solid var(--bdr)" }}>
                  <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:12, fontWeight:600, color:"var(--pri)", marginBottom:3 }}>
                        Goal {gi+1} · <span style={{ color:"var(--txt2)" }}>{g.goalType==="trials"?"🔢 Trials":g.goalType==="rubric"?"📊 Rubric":"📏 PM"}{g.goalType==="trials"?` (${g.trialSize||5}/set)`:""}</span>
                      </div>
                      <div style={{ fontSize:13, color:"var(--txt)", lineHeight:1.4 }}>{g.description || <span className="muted">No description</span>}</div>
                    </div>
                    <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                      <button className="btn btn-o btn-sm" onClick={() => openEditGoal(g)}>Edit</button>
                      <button className="btn btn-d btn-sm" onClick={() => deleteGoal(g.id)}>✕</button>
                    </div>
                  </div>
                </div>
              ))}

              {/* Inline goal editor */}
              {editingGoal && (
                <div style={{ background:"#fff", border:"2px solid var(--pri)", borderRadius:11, padding:"14px 15px", marginBottom:10 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:"var(--pri)", marginBottom:12, textTransform:"uppercase", letterSpacing:".05em" }}>
                    {editingGoal==="new" ? "New Goal" : "Edit Goal"}
                  </div>
                  <div className="fg">
                    <label className="fl">Goal Description</label>
                    <textarea className="fc" rows={2} placeholder="Describe the IEP goal..." value={goalForm.description} onChange={e => setGF2(f=>({...f,description:e.target.value}))} />
                  </div>
                  <div className="fg">
                    <label className="fl">Tracking Method</label>
                    <div className="pill-wrap">
                      {[["trials","🔢 Trials"],["rubric","📊 Rubric"],["pm","📏 PM"]].map(([t,lbl]) => (
                        <button key={t} className={`pill ${goalForm.goalType===t?"sel":""}`} onClick={() => setGF2(f=>({...f,goalType:t}))}>{lbl}</button>
                      ))}
                    </div>
                  </div>
                  {goalForm.goalType==="trials" && (
                    <div className="fg">
                      <label className="fl">Trials per Set</label>
                      <div className="pill-wrap">
                        {[3,4,5,6,8,10].map(n=>(
                          <button key={n} className={`pill ${Number(goalForm.trialSize)===n?"sel":""}`} onClick={()=>setGF2(f=>({...f,trialSize:n}))}>{n}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  {goalForm.goalType==="rubric" && (
                    <div className="fg">
                      <label className="fl">Rubric Levels</label>
                      <div className="tags">
                        {(goalForm.rubricLevels||[]).map((l,i)=>(
                          <span key={i} className="tag">{l}<span className="tag-x" onClick={()=>setGF2(f=>({...f,rubricLevels:f.rubricLevels.filter((_,j)=>j!==i)}))}>×</span></span>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:7}}>
                        <input className="fc" style={{flex:1}} placeholder='e.g. "1 - Beginning"' value={rubricIn} onChange={e=>setRubricIn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addRubric2()} />
                        <button className="btn btn-o" onClick={addRubric2}>Add</button>
                      </div>
                    </div>
                  )}
                  {goalForm.goalType==="pm" && (
                    <div className="fr">
                      <div className="fg">
                        <label className="fl">Goal Score</label>
                        <input type="number" className="fc" placeholder="e.g. 100" value={goalForm.pmGoalScore} onChange={e=>setGF2(f=>({...f,pmGoalScore:e.target.value}))} />
                      </div>
                      <div className="fg">
                        <label className="fl">Last PM Date</label>
                        <input type="date" className="fc" value={goalForm.lastPmDate} onChange={e=>setGF2(f=>({...f,lastPmDate:e.target.value}))} />
                      </div>
                    </div>
                  )}
                  <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:4}}>
                    <button className="btn btn-g btn-sm" onClick={()=>setEditingGoal(null)}>Cancel</button>
                    <button className="btn btn-p btn-sm" onClick={saveGoal}>Save Goal</button>
                  </div>
                </div>
              )}
              </>)}
              <div className="div" />
              <div className="sec">{form.studentType==="IEP" ? "Meeting / IEP Info" : form.studentType==="504" ? "504 Plan Info" : "Meeting Info"}</div>
              <div className="fg">
                <label className="fl">Meeting Type</label>
                <div className="pill-wrap">
                  {form.studentType==="IEP" && <>
                    <button className={`pill ${form.meetingType==="Annual"?"sel":""}`} onClick={() => setF("meetingType","Annual")}>Annual IEP</button>
                    <button className={`pill ${form.meetingType==="Reevaluation"?"sel":""}`} onClick={() => setF("meetingType","Reevaluation")}>Re-evaluation</button>
                  </>}
                  {form.studentType==="504" && <>
                    <button className={`pill ${form.meetingType==="Annual"?"sel":""}`} onClick={() => setF("meetingType","Annual")}>Annual Review</button>
                    <button className={`pill ${form.meetingType==="Reevaluation"?"sel":""}`} onClick={() => setF("meetingType","Reevaluation")}>Re-evaluation</button>
                  </>}
                  {form.studentType==="GenEd" && <>
                    <button className={`pill ${form.meetingType==="Annual"?"sel":""}`} onClick={() => setF("meetingType","Annual")}>Annual</button>
                    <button className={`pill ${form.meetingType==="Other"?"sel":""}`} onClick={() => setF("meetingType","Other")}>Other</button>
                  </>}
                </div>
              </div>
              <div className="fr">
                <div className="fg">
                  <label className="fl">Meeting Due Date</label>
                  <input type="date" className="fc" value={form.meetingDueDate} onChange={e => setF("meetingDueDate", e.target.value)} />
                </div>
                <div className="fg">
                  <label className="fl">Scheduled Date</label>
                  <input type="date" className="fc" value={form.meetingScheduledDate} onChange={e => setF("meetingScheduledDate", e.target.value)} />
                </div>
              </div>
            </div>
            <div className="mf">
              <button className="btn btn-g" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn btn-p" onClick={handleSave} disabled={!form.name.trim()||saving}>
                {saving ? "Saving…" : editId ? "Save Changes" : "Add Student"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════
   GOAL PROGRESS PAGE
══════════════════════════════════════ */
function GoalProgressPage({ students, sessions }) {
  const [selStudent, setSelStudent] = useState("");
  const [selGoalId, setSelGoalId] = useState("");

  const student = students.find(s => s.id === selStudent);
  const studentGoals = student ? getStudentGoals(student) : [];
  const selectedGoal = studentGoals.find(g => g.id === selGoalId) || (studentGoals.length === 1 ? studentGoals[0] : null);

  // When student changes, auto-select first goal
  const prevStudent = useMemo(() => selStudent, [selStudent]);
  useEffect(() => {
    if (studentGoals.length === 1) setSelGoalId(studentGoals[0].id);
    else setSelGoalId("");
  }, [selStudent]);

  const studentSessions = useMemo(() => {
    if (!selStudent || !selectedGoal) return [];
    return sessions
      .filter(s => {
        if (s.studentId !== selStudent) return false;
        if (!s.goalData) return false;
        // Match by goalId if present, otherwise match legacy sessions to any goal
        if (s.goalData.goalId) return s.goalData.goalId === selectedGoal.id;
        // Legacy: no goalId — match if this is the first/only goal
        const goals = getStudentGoals(student);
        return goals.indexOf(selectedGoal) === 0;
      })
      .filter(s => s.goalData.correct !== undefined || s.goalData.rubricScore || s.goalData.pmScore !== undefined)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [selStudent, selGoalId, sessions, selectedGoal]);

  // Build chart data
  const trialSize = selectedGoal?.trialSize || 5;

  // For trials: group into sets of trialSize across all sessions
  const trialSets = useMemo(() => {
    if (!selectedGoal || selectedGoal.goalType !== "trials") return [];
    return groupTrialsIntoSets(studentSessions, student.id, trialSize).sets;
  }, [studentSessions, selectedGoal, trialSize]);

  const chartData = useMemo(() => {
    if (!student) return [];
    if (student.goalType === "trials") {
      return trialSets.map(set => ({
        date: set.endDate,
        value: set.pct,
        label: `${set.correct}/${set.total} (${set.pct}%) — Set ${set.setNum}`,
        setNum: set.setNum,
        set,
      }));
    }
    return studentSessions.map((s, i) => {
      const gd = s.goalData;
      let value = null;
      let label = "";
      if (gd.pmScore !== undefined) {
        value = Number(gd.pmScore);
        label = String(gd.pmScore);
      } else if (gd.rubricScore) {
        const match = gd.rubricScore.match(/\d+(\.\d+)?/);
        value = match ? parseFloat(match[0]) : i + 1;
        label = gd.rubricScore;
      } else if (gd.correct !== undefined) {
        const total = (Number(gd.correct) || 0) + (Number(gd.incorrect) || 0);
        value = total > 0 ? Math.round((Number(gd.correct) / total) * 100) : 0;
        label = `${gd.correct}/${total} (${value}%)`;
      }
      return { date: s.date, value, label, session: s };
    }).filter(d => d.value !== null);
  }, [selectedGoal, studentSessions, trialSets]);

  // SVG chart dimensions
  const W = 600, H = 220, PAD = { top: 20, right: 20, bottom: 40, left: 48 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const isTrials = selectedGoal?.goalType === "trials";
  const isRubric = selectedGoal?.goalType === "rubric";
  const isPM     = selectedGoal?.goalType === "pm";

  const maxVal = isTrials ? 100 : Math.max(...(chartData.length ? chartData.map(d => d.value) : [0]), Number(selectedGoal?.pmGoalScore)||10, 4);
  const minVal = 0;

  const xScale = (i) => chartData.length < 2 ? chartW / 2 : (i / (chartData.length - 1)) * chartW;
  const yScale = (v) => chartH - ((v - minVal) / (maxVal - minVal)) * chartH;

  const pathD = chartData.map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(d.value)}`).join(" ");
  const areaD = chartData.length > 0
    ? `${pathD} L ${xScale(chartData.length - 1)} ${chartH} L ${xScale(0)} ${chartH} Z`
    : "";

  // Stats
  const avg = chartData.length > 0 ? Math.round(chartData.reduce((a, d) => a + d.value, 0) / chartData.length) : null;
  const latest = chartData.length > 0 ? chartData[chartData.length - 1].value : null;
  const first = chartData.length > 0 ? chartData[0].value : null;
  const trend = first !== null && latest !== null ? latest - first : null;

  // Y axis ticks
  const yTicks = isTrials
    ? [0, 25, 50, 75, 100]
    : isPM
      ? Array.from({ length: 6 }, (_, i) => Math.round((maxVal / 5) * i))
      : Array.from({ length: Math.min(Math.ceil(maxVal) + 1, 10) }, (_, i) => Math.round((maxVal / Math.min(Math.ceil(maxVal), 9)) * i));

  // All sessions table
  const allSessions = useMemo(() => {
    if (!selStudent) return [];
    return sessions
      .filter(s => s.studentId === selStudent)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [selStudent, sessions]);

  return (
    <div>
      {/* Student + Goal selector */}
      <div style={{ marginBottom: 16, display:"flex", gap:10, flexWrap:"wrap", alignItems:"flex-end" }}>
        <div className="fg" style={{ flex:1, minWidth:0, marginBottom: 0 }}>
          <label className="fl">Select Student</label>
          <select className="fc" value={selStudent} onChange={e => { setSelStudent(e.target.value); }}>
            <option value="">Choose a student...</option>
            {students.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {student && studentGoals.length > 1 && (
          <div className="fg" style={{ flex:1, minWidth:0, marginBottom:0 }}>
            <label className="fl">Select Goal</label>
            <select className="fc" value={selGoalId} onChange={e => setSelGoalId(e.target.value)}>
              <option value="">Choose a goal...</option>
              {studentGoals.map((g,i) => (
                <option key={g.id} value={g.id}>Goal {i+1}: {g.description?(g.description.length>40?g.description.slice(0,40)+"…":g.description):g.goalType}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {selStudent && student && !selectedGoal && studentGoals.length > 1 && (
        <div className="empty"><div className="empty-i">🎯</div><p>Select a goal above to view the progress chart.</p></div>
      )}
      {!selStudent && (
        <div className="empty"><div className="empty-i">📈</div><p>Select a student{student && studentGoals.length > 1 ? " and goal" : ""} above to view their goal progress chart.</p></div>
      )}

      {selStudent && student && selectedGoal && (
        <>
          {/* Goal info card */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="ch">
              <span className="ct">{student.name} — {selectedGoal ? (selectedGoal.description ? (selectedGoal.description.length>35?selectedGoal.description.slice(0,35)+"…":selectedGoal.description) : "Goal") : "Goal"}</span>
              <span className={`bdg ${isRubric ? "bdg-r" : isPM ? "bdg-n" : "bdg-a"}`}>{isRubric ? "📊 Rubric" : isPM ? "📏 PM" : "🔢 Trials"}</span>
            </div>
            <div className="cb" style={{ paddingBottom: 14 }}>
              {selectedGoal?.description ? (
                <div style={{ fontSize: 13.5, color: "var(--txt)", lineHeight: 1.65, padding: "10px 14px", background: "var(--inp)", borderRadius: 9, marginBottom: 14 }}>
                  🎯 <strong>IEP Goal:</strong> {selectedGoal.description}
                </div>
              ) : (
                <div style={{ color: "var(--txt2)", fontSize: 13, marginBottom: 14 }}>No goal description set. Add one in Manage Students.</div>
              )}
              {isTrials && (() => {
                const { remainder, totalTrials } = groupTrialsIntoSets(studentSessions, student?.id, trialSize);
                return remainder > 0 ? (
                  <div style={{ fontSize:12.5, color:"var(--txt2)", background:"var(--inp)", borderRadius:8, padding:"7px 12px", marginBottom:12, display:"flex", gap:6 }}>
                    <span>↩</span>
                    <span><strong>{remainder}</strong> trial{remainder !== 1 ? "s" : ""} in progress — need <strong>{trialSize - remainder}</strong> more to complete next set (total: {totalTrials} trials logged)</span>
                  </div>
                ) : null;
              })()}

              {/* Stats row */}
              <div className="sg4 gp-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                <div className="sc">
                  <div className="sl">{isTrials ? `${trialSize}-Trial Sets` : "Sessions w/ Data"}</div>
                  <div className="sv">{isTrials ? trialSets.length : chartData.length}</div>
                </div>
                <div className="sc">
                  <div className="sl">Latest Score</div>
                  <div className="sv" style={{ color: "var(--pri)" }}>{latest !== null ? (isTrials ? `${latest}%` : latest) : "—"}</div>
                </div>
                <div className="sc">
                  <div className="sl">Average</div>
                  <div className="sv">{avg !== null ? (isTrials ? `${avg}%` : avg) : "—"}</div>
                </div>
                <div className="sc">
                  <div className="sl">Trend</div>
                  <div className="sv" style={{ color: trend === null ? "var(--txt2)" : trend >= 0 ? "var(--grn)" : "var(--red)" }}>
                    {trend === null ? "—" : `${trend >= 0 ? "+" : ""}${trend}${isTrials ? "%" : ""}`}
                  </div>
                  {trend !== null && <div style={{ fontSize: 10, color: "var(--txt2)" }}>since first session</div>}
                </div>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="ch">
              <span className="ct">{isTrials ? `${trialSize}-Trial Set Progress` : "Progress Chart"}</span>
              <span className="sm muted">{isTrials ? `${trialSets.length} complete sets` : `${chartData.length} data points`}</span>
            </div>
            <div className="cb">
              {chartData.length < 2 ? (
                <div className="empty" style={{ padding: "28px 20px" }}>
                  <div className="empty-i">📊</div>
                  <p>Log at least 2 sessions with goal data to see the chart.</p>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", minWidth: 280 }}>
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2d7d5e" stopOpacity="0.18" />
                        <stop offset="100%" stopColor="#2d7d5e" stopOpacity="0.01" />
                      </linearGradient>
                    </defs>
                    <g transform={`translate(${PAD.left}, ${PAD.top})`}>
                      {/* Grid lines + Y labels */}
                      {yTicks.map(t => (
                        <g key={t}>
                          <line x1={0} y1={yScale(t)} x2={chartW} y2={yScale(t)} stroke="#e0ebe5" strokeWidth="1" strokeDasharray={t === 0 ? "none" : "4,3"} />
                          <text x={-8} y={yScale(t) + 4} textAnchor="end" fontSize="10" fill="#7a9e8e">{isTrials ? `${t}%` : t}</text>
                        </g>
                      ))}

                      {/* Goal line */}
                      {isTrials && (
                        <g>
                          <line x1={0} y1={yScale(80)} x2={chartW} y2={yScale(80)} stroke="#2d7d5e" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.5" />
                          <text x={chartW + 4} y={yScale(80) + 4} fontSize="10" fill="#2d7d5e" opacity="0.7">80% goal</text>
                        </g>
                      )}
                      {isPM && selectedGoal?.pmGoalScore && (
                        <g>
                          <line x1={0} y1={yScale(Number(selectedGoal.pmGoalScore))} x2={chartW} y2={yScale(Number(selectedGoal.pmGoalScore))} stroke="#2d7d5e" strokeWidth="1.5" strokeDasharray="6,4" opacity="0.5" />
                          <text x={chartW + 4} y={yScale(Number(selectedGoal.pmGoalScore)) + 4} fontSize="10" fill="#2d7d5e" opacity="0.7">Goal: {selectedGoal.pmGoalScore}</text>
                        </g>
                      )}

                      {/* Area fill */}
                      <path d={areaD} fill="url(#chartGrad)" />

                      {/* Line */}
                      <path d={pathD} fill="none" stroke="#2d7d5e" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

                      {/* Data points + tooltips */}
                      {chartData.map((d, i) => (
                        <g key={i}>
                          <circle cx={xScale(i)} cy={yScale(d.value)} r="5" fill="#fff" stroke="#2d7d5e" strokeWidth="2.5" />
                          {/* Hover label */}
                          <title>{d.date}: {d.label}</title>
                          {/* Date label on x axis */}
                          <text
                            x={xScale(i)}
                            y={chartH + 18}
                            textAnchor="middle"
                            fontSize="9"
                            fill="#7a9e8e"
                            transform={chartData.length > 8 ? `rotate(-35, ${xScale(i)}, ${chartH + 18})` : ""}
                          >
                            {isTrials ? `Set ${d.setNum}` : d.date.slice(5)}
                          </text>
                          {/* Value label above point */}
                          <text x={xScale(i)} y={yScale(d.value) - 10} textAnchor="middle" fontSize="10" fontWeight="600" fill="#2d7d5e">
                            {isTrials ? `${d.value}%` : d.value}
                          </text>
                          {isPM && selectedGoal?.pmGoalScore && (
                            <circle cx={xScale(i)} cy={yScale(d.value)} r="5"
                              fill={Number(d.value) >= Number(selectedGoal?.pmGoalScore) ? "#1f6e4a" : "#fff"}
                              stroke="#2d7d5e" strokeWidth="2.5" />
                          )}
                        </g>
                      ))}
                    </g>
                  </svg>
                </div>
              )}
            </div>
          </div>

          {/* Session data table */}
          <div className="card">
            <div className="ch"><span className="ct">Session Data</span><span className="sm muted">{selectedGoal?.description ? (selectedGoal.description.length>30?selectedGoal.description.slice(0,30)+"…":selectedGoal.description) : student.name}</span></div>
            {allSessions.length === 0 ? (
              <div className="empty"><div className="empty-i">📋</div><p>No sessions logged yet.</p></div>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr>
                    <th>Date</th>
                    <th>Direct Min</th>
                    <th>Indirect Min</th>
                    {isTrials && <><th>Correct</th><th>Incorrect</th><th>% Correct</th></>}
                    {isRubric && <th>Rubric Score</th>}
                    {isPM && <th>PM Score</th>}
                    <th>Notes</th>
                  </tr></thead>
                  <tbody>
                    {allSessions.map(s => {
                      const gd = s.goalData;
                      const trialArr = gd?.trials;
                      const trialsCorrect = trialArr ? trialArr.filter(t => t==="C").length : (Number(gd?.correct)||0);
                      const total = trialArr ? trialArr.length : (Number(gd?.correct) || 0) + (Number(gd?.incorrect) || 0);
                      const pct = total > 0 ? Math.round((trialsCorrect / total) * 100) : null;
                      const metGoal = (isTrials && pct !== null && pct >= 80) || (isPM && gd?.pmScore !== undefined && selectedGoal?.pmGoalScore && Number(gd.pmScore) >= Number(selectedGoal.pmGoalScore));
                      return (
                        <tr key={s.id} className={metGoal ? "rg" : ""}>
                          <td style={{ whiteSpace: "nowrap", fontWeight: 500 }}>{s.date}</td>
                          <td>{s.directMinutes || 0}m</td>
                          <td>{s.indirectMinutes || 0}m</td>
                          {isTrials && (
                            <>
                              <td>
                                {gd?.trials ? (
                                  <div style={{ display:"flex", gap:2, flexWrap:"wrap" }}>
                                    {gd.trials.map((t, ti) => (
                                      <span key={ti} style={{ width:20, height:20, borderRadius:"50%", background: t==="C"?"#d1f5e5":"#fde0e0", border: t==="C"?"1.5px solid var(--grn)":"1.5px solid var(--red)", display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, color: t==="C"?"var(--grn)":"var(--red)" }}>{t==="C"?"✓":"✗"}</span>
                                    ))}
                                  </div>
                                ) : <span style={{ color:"var(--grn)", fontWeight:600 }}>✅ {gd?.correct ?? "—"}</span>}
                              </td>
                              <td><span style={{ color: "var(--txt2)", fontSize:12 }}>{gd?.trials ? `${gd.trials.filter(t=>t==="C").length}/${gd.trials.length}` : (gd?.incorrect ?? "—")}</span></td>
                              <td>
                                {pct !== null ? (
                                  <span style={{ fontWeight: 700, color: pct >= 80 ? "var(--grn)" : pct >= 60 ? "var(--ora)" : "var(--red)" }}>
                                    {pct}%
                                  </span>
                                ) : "—"}
                              </td>
                            </>
                          )}
                          {isRubric && (
                            <td><span className="bdg bdg-r">{gd?.rubricScore || "—"}</span></td>
                          )}
                          {isPM && (
                            <td>
                              <span style={{ fontWeight:700, fontSize:15, color: selectedGoal?.pmGoalScore && gd?.pmScore >= Number(selectedGoal.pmGoalScore) ? "var(--grn)" : "var(--pri)" }}>
                                {gd?.pmScore ?? "—"}
                              </span>
                              {selectedGoal?.pmGoalScore && gd?.pmScore !== undefined && (
                                <span style={{ fontSize:11, color:"var(--txt2)", marginLeft:5 }}>/ {selectedGoal.pmGoalScore}</span>
                              )}
                            </td>
                          )}
                          <td style={{ maxWidth: 220, fontSize: 12, color: "var(--txt2)" }}>
                            {s.notes ? (s.notes.length > 70 ? s.notes.slice(0, 70) + "…" : s.notes) : <span className="muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
