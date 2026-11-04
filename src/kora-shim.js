// Kora · capa de plataforma para la app propia.
// El agente contable se escribió sobre una API pequeña (window.claude.use("db" | "user" | "sample" | "downloads" | "assets")).
// Este módulo la implementa con Firebase: Firestore para los libros, Auth con Google para las personas y
// Firebase AI Logic (Gemini) para Kora. Cada ruta del agente vive dentro de libros/{libro}/…, así un mismo
// código sirve para Kotic y para cualquier otro libro contable.
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut } from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, orderBy, limit, where,
  runTransaction, writeBatch, arrayUnion, arrayRemove,
} from "firebase/firestore";
import { getAI, getGenerativeModel, GoogleAIBackend } from "firebase/ai";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { fs = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: memoryLocalCache() }); }

const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const normEmail = e => String(e || "").trim().toLowerCase();
const ROLES = { admin:"Administrador", contador:"Contador", taquilla:"Taquilla", barra:"Barra", lector:"Solo lectura" };
const ESCRIBEN = ["admin", "contador", "taquilla", "barra"];

// ---------------- estado de la sesión ----------------
const K = { user:null, libroId:null, libro:null, equipo:null, rol:"nadie" };
let listo; const ready = new Promise(r => { listo = r; });
const cola = window.__koraCola || []; // pedidos que hizo el agente antes de que cargara este módulo
window.claude = { use: nombre => ready.then(() => api(nombre)) };
ready.then(() => cola.splice(0).forEach(([n, r]) => r(api(n))));
window.KORA_APP = { version: 1, abrirLibros: () => pantallaLibros(), salir: () => salir(), invitar, quitarInvitado, info: () => ({ ...K, user: K.user && { uid:K.user.uid, email:K.user.email, nombre:K.user.displayName } }) };

// ---------------- Firestore con la forma que espera el agente ----------------
const P = p => `libros/${K.libroId}/${String(p).replace(/^\/+/, "")}`;
const wDS = d => ({ id: d.id, exists: d.exists(), data: () => d.data(), metadata: { fromCache: d.metadata.fromCache, hasPendingWrites: d.metadata.hasPendingWrites } });
const wQS = s => ({ docs: s.docs.map(wDS), size: s.size, empty: s.empty, metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
const errApp = e => { const c = e && e.code; const code = c === "permission-denied" ? "invalid_argument" : c === "resource-exhausted" ? "quota_exceeded" : c === "unavailable" ? "unavailable" : (c || "error"); const x = new Error(e && e.message || "Error"); x.code = code; x.original = e; return x; };
const pr = f => f.catch(e => { throw errApp(e); });
function wCol(path, cons = []) {
  const ref = () => collection(fs, P(path)), q = () => cons.length ? query(ref(), ...cons) : ref();
  return {
    path,
    onSnapshot(next, err) { return onSnapshot(q(), { includeMetadataChanges: false }, s => next(wQS(s)), e => err && err(errApp(e))); },
    get: () => pr(getDocs(q()).then(wQS)),
    add: data => pr(addDoc(ref(), data).then(r => ({ id: r.id }))),
    doc: id => wDoc(`${path}/${id}`),
    orderBy: (f, dir) => wCol(path, [...cons, orderBy(f, dir || "asc")]),
    limit: n => wCol(path, [...cons, limit(n)]),
    where: (f, op, v) => wCol(path, [...cons, where(f, op, v)]),
  };
}
const extraMiembro = path => /^miembros\/[^/]+$/.test(path) && K.user ? { email: normEmail(K.user.email), nombre: K.user.displayName || "" } : {};
function wDoc(path) {
  const ref = () => doc(fs, P(path));
  return {
    id: path.split("/").pop(), path,
    get: () => pr(getDoc(ref()).then(wDS)),
    set: (data, o) => pr(setDoc(ref(), { ...data, ...extraMiembro(path) }, o && o.merge ? { merge: true } : {})),
    update: data => pr(updateDoc(ref(), data)),
    delete: () => pr(deleteDoc(ref())),
    onSnapshot(next, err) { return onSnapshot(ref(), s => next(wDS(s)), e => err && err(errApp(e))); },
    // Turno corto (lo usa la numeración de asientos): solo quien lo tiene escribe el siguiente número.
    async acquire({ holder, ttlMs = 4000 } = {}) {
      return pr(runTransaction(fs, async tx => {
        const s = await tx.get(ref()), now = Date.now(), d = s.exists() ? s.data() : null;
        if (d && d.holder && d.holder !== holder && +d.hasta > now) return { acquired: false, holder: d.holder };
        tx.set(ref(), { holder, hasta: now + ttlMs, por: K.user ? K.user.uid : null });
        return { acquired: true, holder, expiresAt: now + ttlMs };
      }));
    },
  };
}
const dbApi = { collection: p => wCol(p), doc: p => wDoc(p) };

// ---------------- personas ----------------
const userApi = {
  id: async () => K.user.uid,
  isOwner: async () => !!(K.libro && K.libro.owner === K.user.uid),
  can: async what => what === "data.write" ? ESCRIBEN.includes(K.rol) : null,
  canEdit: async () => K.rol === "admin" || K.rol === "contador",
  profiles: async ids => { const out = {}; await Promise.all(ids.map(async id => { try { const s = await getDoc(doc(fs, P(`miembros/${id}`))); const d = s.exists() ? s.data() : {}; out[id] = { name: d.nombre || d.email || "" }; } catch (e) { out[id] = { name: "" }; } })); return out; },
};

// ---------------- descargas ----------------
const downloadsApi = {
  async save({ filename, data, mimeType }) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || (/\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : /\.html?$/i.test(filename) ? "text/html;charset=utf-8" : /\.json$/i.test(filename) ? "application/json" : /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream") });
    const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = filename || "descarga"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000); return { saved: true };
  },
};

// ---------------- fotos de soportes (comprimidas dentro de la base, sin Storage de pago) ----------------
async function comprimir(blob, max = 1280, q = .72) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
  let w = img.naturalWidth, h = img.naturalHeight; const f = Math.min(1, max / Math.max(w, h)); w = Math.round(w * f); h = Math.round(h * f);
  const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
  let url = c.toDataURL("image/jpeg", q); while (url.length > 900000 && q > .3) { q -= .12; url = c.toDataURL("image/jpeg", q); }
  return url;
}
const assetsApi = {
  async upload(blob) {
    const data = await comprimir(blob), id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await pr(setDoc(doc(fs, P(`soportes/${id}`)), { data, ts: new Date().toISOString(), autor: K.user.uid }));
    return { id, url: `/_blob/${id}` };
  },
};
document.addEventListener("click", async e => {
  const a = e.target.closest && e.target.closest('a[href^="/_blob/"]'); if (!a) return;
  e.preventDefault(); const id = a.getAttribute("href").split("/").pop(), w = window.open("", "_blank");
  try { const s = await getDoc(doc(fs, P(`soportes/${id}`))); if (!s.exists()) throw 0; const src = s.data().data;
    if (w) { w.document.title = "Soporte"; w.document.body.style.cssText = "margin:0;background:#111;display:grid;place-items:center;min-height:100vh"; const im = w.document.createElement("img"); im.src = src; im.style.cssText = "max-width:100%;max-height:100vh"; w.document.body.appendChild(im); } }
  catch (err) { if (w) w.close(); alert("No se encontró la foto del soporte."); }
}, true);

// ---------------- Kora con Gemini (Firebase AI Logic) ----------------
const MODELOS = { quick: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"], default: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"] };
const iaActiva = () => LS.get("kora-ia") !== "off";
let ai = null; const modeloOk = {};
const getAi = () => ai || (ai = getAI(app, { backend: new GoogleAIBackend() }));
const toSchema = s => { if (!s || typeof s !== "object") return s; const o = {}; for (const [k, v] of Object.entries(s)) { if (k === "additionalProperties" || k === "$schema") continue; o[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toSchema(pv)])) : k === "items" ? toSchema(v) : v; } return o; };
async function blobPart(b) { const buf = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return { inlineData: { mimeType: b.type || "image/jpeg", data: btoa(s) } }; }
async function conModelo(tier, fn) {
  const lista = MODELOS[tier === "quick" ? "quick" : "default"], ord = modeloOk[tier] ? [modeloOk[tier], ...lista.filter(m => m !== modeloOk[tier])] : lista;
  let ult;
  for (const m of ord) { try { const r = await fn(m); modeloOk[tier] = m; return r; } catch (e) { ult = e; const t = String(e && (e.message || e.code) || ""); if (!/not.?found|404|unsupported|not supported|is not available|invalid model/i.test(t)) break; } }
  const x = new Error(String(ult && ult.message || "La IA no respondió.")); x.code = /quota|429|exhausted/i.test(x.message) ? "rate_limited" : /api.*not.*enabled|has not been used|PERMISSION_DENIED|403/i.test(x.message) ? "unavailable" : "error"; throw x;
}
async function sampleTxt(input, opts = {}) {
  if (!iaActiva()) { const x = new Error("La IA está apagada."); x.code = "unavailable"; throw x; }
  const tools = (opts.tools || []).slice(0, 12), parts = [{ text: String(input) }];
  for (const b of (opts.images || [])) parts.push(await blobPart(b));
  return conModelo(opts.modelTier, async modelo => {
    const params = { model: modelo };
    if (tools.length) params.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description || "", ...(t.inputSchema && t.inputSchema.properties && Object.keys(t.inputSchema.properties).length ? { parameters: toSchema(t.inputSchema) } : {}) })) }];
    const model = getGenerativeModel(getAi(), params);
    if (!tools.length) {
      if (opts.onText) { const r = await model.generateContentStream({ contents: [{ role: "user", parts }] }); let txt = ""; for await (const ch of r.stream) { const d = ch.text(); if (d) { txt += d; try { opts.onText({ text: txt, delta: d }); } catch (e) {} } } return { text: txt.trim() }; }
      const r = await model.generateContent({ contents: [{ role: "user", parts }] }); return { text: r.response.text().trim() };
    }
    const chat = model.startChat(); let res = await chat.sendMessage(parts);
    for (let vuelta = 0; vuelta < 6; vuelta++) {
      const calls = res.response.functionCalls ? (res.response.functionCalls() || []) : [];
      if (!calls.length) break;
      const resp = [];
      for (const c of calls) { const t = tools.find(x => x.name === c.name); let out;
        try { out = t ? await t.execute(c.args || {}) : { error: "Herramienta desconocida." }; } catch (e) { out = { error: String(e && e.message || e) }; }
        resp.push({ functionResponse: { name: c.name, response: out && typeof out === "object" && !Array.isArray(out) ? out : { resultado: out } } }); }
      res = await chat.sendMessage(resp);
    }
    const text = (res.response.text() || "").trim(); if (opts.onText && text) { try { opts.onText({ text, delta: text }); } catch (e) {} }
    return { text };
  });
}
sampleTxt.json = async (input, opts = {}) => {
  const r = await sampleTxt(`${input}\n\nResponde únicamente con JSON válido, sin texto adicional ni bloques de código.`, { ...opts, onText: undefined, tools: undefined });
  const t = r.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim(), m = t.match(/[\[{][\s\S]*[\]}]/);
  try { return JSON.parse(m ? m[0] : t); } catch (e) { const x = new Error("La IA no devolvió JSON."); x.code = "invalid_json"; x.text = r.text; throw x; }
};
sampleTxt.limits = async () => ({ inputBytes: 400000, images: { maxCount: 4, maxBytes: 7000000, mediaTypes: ["image/jpeg", "image/png", "image/webp"] }, tools: { maxCount: 12 }, modelTiers: ["quick", "default"] });

function api(nombre) {
  if (nombre === "db") return dbApi;
  if (nombre === "user") return userApi;
  if (nombre === "downloads") return downloadsApi;
  if (nombre === "assets") return ESCRIBEN.includes(K.rol) ? assetsApi : null;
  if (nombre === "sample") return iaActiva() ? sampleTxt : null;
  return null;
}

// ---------------- libros, invitaciones y roles ----------------
async function cargarLibro(id) {
  const s = await getDoc(doc(fs, `libros/${id}`)); if (!s.exists()) return false;
  K.libroId = id; K.libro = { id, ...s.data() };
  try { const e = await getDoc(doc(fs, `libros/${id}/config/equipo`)); K.equipo = e.exists() ? e.data() : { roles: {}, invitados: {} }; } catch (e) { K.equipo = { roles: {}, invitados: {} }; }
  const em = normEmail(K.user.email);
  K.rol = K.libro.owner === K.user.uid ? "admin" : ((K.equipo.roles || {})[K.user.uid] || (K.equipo.invitados || {})[em] || "nadie");
  return true;
}
async function misLibros() {
  const em = normEmail(K.user.email), out = new Map();
  try { (await getDocs(query(collection(fs, "libros"), where("acceso", "array-contains", em)))).docs.forEach(d => out.set(d.id, { id: d.id, ...d.data() })); } catch (e) {}
  try { (await getDocs(query(collection(fs, "libros"), where("owner", "==", K.user.uid)))).docs.forEach(d => out.set(d.id, { id: d.id, ...d.data() })); } catch (e) {}
  return [...out.values()].sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}
const slug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "libro";
async function crearLibro(nombre) {
  const id = `${slug(nombre)}-${Math.random().toString(36).slice(2, 6)}`, em = normEmail(K.user.email);
  await setDoc(doc(fs, `libros/${id}`), { nombre: nombre.trim(), owner: K.user.uid, ownerEmail: em, acceso: [em], creado: new Date().toISOString() });
  await setDoc(doc(fs, `libros/${id}/config/equipo`), { roles: { [K.user.uid]: "admin" }, invitados: {}, defecto: "lector" });
  return id;
}
async function invitar(email, rol) {
  const em = normEmail(email); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Error("Escribe un correo válido.");
  if (!ROLES[rol] || rol === "admin") throw new Error("Rol no válido.");
  const eqRef = doc(fs, `libros/${K.libroId}/config/equipo`), cur = (await getDoc(eqRef)).data() || {};
  await setDoc(eqRef, { ...cur, invitados: { ...(cur.invitados || {}), [em]: rol } });
  await updateDoc(doc(fs, `libros/${K.libroId}`), { acceso: arrayUnion(em) });
}
async function quitarInvitado(email, uid) {
  const em = normEmail(email), eqRef = doc(fs, `libros/${K.libroId}/config/equipo`), cur = (await getDoc(eqRef)).data() || {};
  const inv = { ...(cur.invitados || {}) }; delete inv[em]; const roles = { ...(cur.roles || {}) }; if (uid) delete roles[uid];
  await setDoc(eqRef, { ...cur, invitados: inv, roles });
  await updateDoc(doc(fs, `libros/${K.libroId}`), { acceso: arrayRemove(em) });
}

// ---------------- importar el respaldo del agente anterior ----------------
async function importar(json, onProg) {
  const d = typeof json === "string" ? JSON.parse(json) : json;
  if (!d || d.formato !== "kotic-agente" || !Array.isArray(d.eventos)) throw new Error("El archivo no es un respaldo del agente.");
  const ops = [];
  d.eventos.forEach(ev => { ops.push([`eventos/${ev.id}`, ev.data]); Object.entries(ev.sub || {}).forEach(([c, rows]) => rows.forEach(r => ops.push([`eventos/${ev.id}/${c}/${r.id}`, r.data]))); });
  (d.proveedores || []).forEach(r => ops.push([`proveedores/${r.id}`, r.data]));
  if (d.respaldo) ops.push(["respaldo/ultimo", d.respaldo]);
  for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(fs); ops.slice(i, i + 400).forEach(([p, data]) => b.set(doc(fs, P(p)), data)); await b.commit(); onProg && onProg(Math.min(i + 400, ops.length), ops.length); }
  return ops.length;
}

// ---------------- pantallas propias (entrar, escoger libro) ----------------
const css = `
.kx-ov{position:fixed;inset:0;z-index:200;background:var(--bg,#f3f5f4);color:var(--ink,#16231f);display:grid;place-items:center;padding:16px;overflow:auto;font-family:var(--f-body,system-ui)}
.kx-card{width:min(460px,100%);background:var(--surface,#fff);border:1px solid var(--line,#cfd8d5);border-radius:14px;padding:22px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.kx-card h1{font-family:var(--f-display,system-ui);font-size:26px;margin:0 0 4px}.kx-card p{margin:0 0 14px;color:var(--muted,#5a6a65);font-size:14.5px;line-height:1.45}
.kx-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--line,#cfd8d5);background:var(--surface,#fff);color:var(--ink,#16231f);border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer;font:inherit;font-weight:700}
.kx-btn.p{background:var(--accent,#0d6b58);border-color:var(--accent,#0d6b58);color:var(--accent-ink,#fff)}.kx-btn:disabled{opacity:.55;cursor:default}
.kx-list{display:flex;flex-direction:column;gap:8px;margin:0 0 16px}.kx-list button{text-align:left;justify-content:space-between;width:100%}
.kx-list small{color:var(--muted,#5a6a65);font-weight:500}
.kx-row{display:flex;gap:8px;flex-wrap:wrap}.kx-row input{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--line,#cfd8d5);border-radius:10px;background:var(--surface,#fff);color:inherit;font:inherit}
.kx-err{color:var(--bad,#b3261e);font-size:13.5px;margin-top:10px}.kx-sep{border:0;border-top:1px solid var(--line,#cfd8d5);margin:18px 0}
.kx-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--muted,#5a6a65);padding:6px 16px;border-bottom:1px solid var(--line,#cfd8d5);background:var(--surface,#fff)}
.kx-bar b{color:var(--ink,#16231f)}.kx-bar button{border:0;background:none;color:var(--accent,#0d6b58);font:inherit;font-weight:700;cursor:pointer;padding:2px 4px}
.kx-bar .sp{flex:1}
`;
function ov(html) { let o = document.getElementById("kx-ov"); if (!o) { o = document.createElement("div"); o.id = "kx-ov"; o.className = "kx-ov"; document.body.appendChild(o); } o.innerHTML = `<div class="kx-card">${html}</div>`; return o; }
const quitarOv = () => { const o = document.getElementById("kx-ov"); if (o) o.remove(); };
function pantallaEntrar(err) {
  const o = ov(`<h1>Agente contable</h1><p>Entra con tu cuenta de Google para abrir tus libros contables. Solo ves los libros a los que te invitaron.</p>
    <button class="kx-btn p" id="kx-g" style="width:100%">Entrar con Google</button>${err ? `<div class="kx-err">${esc(err)}</div>` : ""}`);
  o.querySelector("#kx-g").onclick = async () => {
    const pv = new GoogleAuthProvider(); pv.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, pv); }
    catch (e) { if (/popup-blocked|operation-not-supported|cancelled-popup/.test(e.code || "")) { try { await signInWithRedirect(auth, pv); } catch (e2) { pantallaEntrar(mensajeAuth(e2)); } } else if (e.code !== "auth/popup-closed-by-user") pantallaEntrar(mensajeAuth(e)); }
  };
}
const mensajeAuth = e => /unauthorized-domain/.test(e && e.code || "") ? "Este dominio aún no está autorizado en Firebase (Authentication → Configuración → Dominios autorizados)." : /network/.test(e && e.code || "") ? "Sin conexión. Revisa tu internet." : "No se pudo entrar. Inténtalo de nuevo.";
async function pantallaLibros(err) {
  const o = ov(`<h1>Tus libros</h1><p>Cargando…</p>`);
  let L = []; try { L = await misLibros(); } catch (e) {}
  const nombre = K.user.displayName || K.user.email;
  o.querySelector(".kx-card").innerHTML = `<h1>Tus libros</h1><p>Hola, ${esc(nombre)}. Escoge el libro contable que vas a abrir.</p>
    ${L.length ? `<div class="kx-list">${L.map(l => `<button class="kx-btn" data-lib="${esc(l.id)}"><span>${esc(l.nombre)}</span><small>${l.owner === K.user.uid ? "Tuyo" : "Invitado"}</small></button>`).join("")}</div>`
      : `<p><b>Todavía no tienes libros.</b> Si te invitaron, pide que usen exactamente este correo: <b>${esc(K.user.email)}</b>.</p>`}
    <hr class="kx-sep"><p style="margin-bottom:8px"><b>Crear un libro nuevo</b> (para otra empresa o proyecto)</p>
    <div class="kx-row"><input id="kx-nom" placeholder="Nombre, por ejemplo Kotic" maxlength="60"><button class="kx-btn p" id="kx-new">Crear</button></div>
    ${err ? `<div class="kx-err">${esc(err)}</div>` : ""}
    <hr class="kx-sep"><button class="kx-btn" id="kx-out">Salir de ${esc(K.user.email)}</button>`;
  o.querySelectorAll("[data-lib]").forEach(b => b.onclick = () => { LS.set("kora-libro", b.dataset.lib); location.reload(); });
  o.querySelector("#kx-out").onclick = () => salir();
  o.querySelector("#kx-new").onclick = async () => { const n = o.querySelector("#kx-nom").value.trim(); if (!n) return; const btn = o.querySelector("#kx-new"); btn.disabled = true;
    try { const id = await crearLibro(n); LS.set("kora-libro", id); location.reload(); } catch (e) { pantallaLibros("No se pudo crear el libro. " + (e.code === "permission-denied" ? "Revisa que las reglas de la base de datos estén publicadas." : "Revisa tu conexión.")); } };
}
async function salir() { LS.set("kora-libro", null); await signOut(auth); location.reload(); }
async function primerUso() {
  // Libro vacío y tuyo: ofrece traer el respaldo del agente anterior.
  if (K.libro.owner !== K.user.uid) return;
  try { const e = await getDocs(query(collection(fs, P("eventos")), limit(1))); if (!e.empty) return; } catch (e) { return; }
  await new Promise(fin => {
    const o = ov(`<h1>${esc(K.libro.nombre)} está vacío</h1><p>Si vienes del agente anterior, sube aquí el archivo que descargaste con «Exportar para la app nueva» (termina en .json). Se copian los eventos, asientos, boletería, inventario, personal, socios, proveedores e historial.</p>
      <input type="file" id="kx-file" accept=".json,application/json" hidden><div class="kx-row"><button class="kx-btn p" id="kx-imp">Escoger el archivo</button><button class="kx-btn" id="kx-skip">Empezar vacío</button></div><div id="kx-msg" class="kx-err" style="color:var(--muted)"></div>`);
    const f = o.querySelector("#kx-file"), msg = o.querySelector("#kx-msg");
    o.querySelector("#kx-imp").onclick = () => f.click(); o.querySelector("#kx-skip").onclick = () => fin();
    f.onchange = async () => { const file = f.files[0]; if (!file) return; msg.textContent = "Leyendo…";
      try { const n = await importar(await file.text(), (a, b) => { msg.textContent = `Copiando ${a} de ${b}…`; }); msg.textContent = `Listo: ${n} documentos copiados.`; setTimeout(fin, 900); }
      catch (e) { msg.style.color = "var(--bad,#b3261e)"; msg.textContent = e.message || "No se pudo importar."; } };
  });
}
function barra() {
  const b = document.createElement("div"); b.className = "kx-bar"; b.id = "kx-bar";
  b.innerHTML = `<span>📒 <b>${esc(K.libro.nombre)}</b> · ${esc(ROLES[K.rol] || "Sin acceso")}</span><span class="sp"></span><span>${esc(K.user.email)}</span><button id="kx-libros">Cambiar de libro</button><button id="kx-ia" title="Kora con IA (Gemini)">IA: ${iaActiva() ? "encendida" : "apagada"}</button><button id="kx-salir">Salir</button>`;
  document.body.prepend(b);
  b.querySelector("#kx-libros").onclick = () => pantallaLibros();
  b.querySelector("#kx-salir").onclick = () => salir();
  b.querySelector("#kx-ia").onclick = () => { LS.set("kora-ia", iaActiva() ? "off" : null); location.reload(); };
}

// ---------------- arranque ----------------
const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
getRedirectResult(auth).catch(e => pantallaEntrar(mensajeAuth(e)));
let arrancado = false;
onAuthStateChanged(auth, async u => {
  if (arrancado) { if (!u) location.reload(); return; }
  if (!u) { pantallaEntrar(); return; }
  K.user = u;
  const id = LS.get("kora-libro");
  let ok = false; if (id) { try { ok = await cargarLibro(id); } catch (e) { ok = false; } }
  if (!ok) { LS.set("kora-libro", null); const L = await misLibros().catch(() => []); if (L.length === 1) { try { ok = await cargarLibro(L[0].id); if (ok) LS.set("kora-libro", L[0].id); } catch (e) {} } }
  if (!ok || K.rol === "nadie") { pantallaLibros(ok ? "No tienes acceso a ese libro." : ""); return; }
  if (!(K.equipo.roles || {})[u.uid] && K.libro.owner !== u.uid) { /* invitado que entra por primera vez: queda registrado como miembro */ }
  await primerUso();
  quitarOv(); barra(); arrancado = true;
  document.title = `${K.libro.nombre} · Agente contable`;
  const h1 = document.querySelector(".brand h1"); if (h1) h1.textContent = `Agente Contable ${K.libro.nombre}`;
  window.KORA_APP.rol = K.rol; window.KORA_APP.email = normEmail(u.email); window.KORA_APP.libro = K.libro;
  listo();
});
