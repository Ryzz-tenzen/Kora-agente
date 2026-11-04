#!/usr/bin/env python3
"""Arma index.html de la app propia a partir del código del agente (src/agente/head.part + body.part).

Los cambios aquí son solo los que necesita la app fuera de claude.ai: invitaciones por correo,
roles que hace cumplir la base de datos y textos que hablaban del menú Compartir.
Uso:  python3 tools/build.py   (luego: npx esbuild src/kora-shim.js --bundle --format=esm --minify --outfile=kora.js)
"""
import pathlib, sys
R = pathlib.Path(__file__).resolve().parent.parent
head = (R / "src/agente/head.part").read_text()
s = (R / "src/agente/body.part").read_text()

def rep(old, new, cnt=1):
    global s
    n = s.count(old)
    if n != cnt:
        sys.exit(f"build: no encontré el texto esperado ({n} veces): {old[:80]!r}")
    s = s.replace(old, new)

# 1) El rol de un invitado sale de su correo hasta que el dueño le asigne uno por cuenta.
rep('const miRol = () => S.isOwner ? "admin" : (S.equipo ? ((S.equipo.roles || {})[S.uid] || S.equipo.defecto || "lector") : "lector");',
    'const miRol = () => S.isOwner ? "admin" : (S.equipo ? ((S.equipo.roles || {})[S.uid] || (S.equipo.invitados || {})[window.KORA_APP && window.KORA_APP.email] || "lector") : "lector");')

# 2) Equipo: invitaciones por correo en vez del menú Compartir.
rep("function vEquipo(v){", r'''function vEquipo(v){ return vEquipoApp(v); }
function vEquipoApp(v){
  const eq = S.equipo || { roles:{}, invitados:{} }, inv = eq.invitados || {}, dueno = S.isOwner;
  const porCorreo = Object.fromEntries(S.miembros.map(m => [String(m.email || "").toLowerCase(), m]));
  const opts = sel => Object.entries(ROLES_APP).filter(([k]) => k !== "admin").map(([k,r]) => `<option value="${k}" ${sel===k?"selected":""}>${r.l}</option>`).join("");
  const filas = Object.entries(inv).sort((a,b) => a[0].localeCompare(b[0]));
  v.innerHTML = `<p class="sub">Invita a cada persona con su correo de Google y escoge su rol. La base de datos hace cumplir el rol: aunque alguien abra el código, solo puede escribir donde su rol lo permite.</p>
  <div class="cards" style="margin-bottom:14px">${Object.entries(ROLES_APP).map(([k,r]) => `<div class="card"><h4><span>${r.l}</span></h4><div class="note" style="margin:0">${r.d}</div></div>`).join("")}</div>
  ${dueno ? `<section class="panel" style="margin-bottom:14px"><h2>Invitar a alguien</h2>
    <div class="form"><label class="field"><span>Correo de Google</span><input type="email" id="inv-mail" placeholder="nombre@gmail.com" autocomplete="off"></label>
    <label class="field"><span>Rol</span><select id="inv-rol">${opts("taquilla")}</select></label></div>
    <div class="actions"><button class="btn primary" id="inv-ok">Invitar</button></div>
    <p class="note">Después le mandas el enlace de la app. Entra con ese mismo correo y ya ve el libro.</p></section>` : `<p class="note">Solo el dueño del libro invita personas y cambia roles.</p>`}
  <div class="tbl-wrap"><table><thead><tr><th>Persona</th><th>Última vez</th><th>Rol</th>${dueno ? "<th></th>" : ""}</tr></thead><tbody>
    <tr><td><b>${esc((window.KORA_APP && window.KORA_APP.libro && window.KORA_APP.libro.ownerEmail) || "Dueño")}</b></td><td class="mono">—</td><td>Administrador (dueño del libro)</td>${dueno ? "<td></td>" : ""}</tr>
    ${filas.map(([mail, rol]) => { const m = porCorreo[mail];
      return `<tr><td>${esc(m && m.nombre ? `${m.nombre} · ${mail}` : mail)}</td><td class="mono">${m && m.visto ? esc(new Date(m.visto).toLocaleString("es-CO", {dateStyle:"short", timeStyle:"short"})) : `<span class="note" style="margin:0">Aún no entra</span>`}</td>
      <td>${dueno ? `<select data-inv="${esc(mail)}" aria-label="Rol">${opts(rol)}</select>` : esc((ROLES_APP[rol] || {}).l || rol)}</td>${dueno ? `<td><button class="btn sm ghost" data-quitar="${esc(mail)}" data-uid="${esc(m ? m.id : "")}">Quitar</button></td>` : ""}</tr>`; }).join("")}
  </tbody></table></div>
  ${filas.length ? "" : `<p class="note">Todavía no has invitado a nadie.</p>`}`;
  const go = async (fn, msg) => { try { await fn(); toast(msg); } catch (err) { toast(err && err.message && !/permission/i.test(err.message) ? err.message : "Solo el dueño del libro puede cambiar el equipo."); } };
  const ok = $("#inv-ok"); if (ok) ok.onclick = () => { const mail = $("#inv-mail").value.trim(), rol = $("#inv-rol").value; go(() => window.KORA_APP.invitar(mail, rol), `Invitado ${mail} como ${ROLES_APP[rol].l.toLowerCase()}`); };
  v.querySelectorAll("[data-inv]").forEach(sel => sel.onchange = () => go(() => window.KORA_APP.invitar(sel.dataset.inv, sel.value), "Rol actualizado"));
  v.querySelectorAll("[data-quitar]").forEach(b => b.onclick = () => go(() => window.KORA_APP.quitarInvitado(b.dataset.quitar, b.dataset.uid), "Acceso quitado"));
}
function vEquipoClaude(v){''')

# 3) Textos que hablaban de claude.ai y del menú Compartir.
rep('"La plataforma no dejó guardar esto con tu nivel de acceso. Pídele al dueño que revise cómo te compartió la página."',
    '"Tu rol no permite guardar esto. Pídele al dueño del libro que revise tu rol en Ajustes → Equipo."')
rep('"La base de datos no está disponible en esta vista. Abre la página en claude.ai con tu cuenta para registrar y ver los asientos."',
    '"No se pudo abrir la base de datos. Revisa tu conexión y recarga la página."')
rep('"Conectando con el libro de Kotic…"', '"Conectando con el libro…"')

for a, b in [("IA (Claude)", "IA (Gemini)"), ("Que Claude consulte", "Que la IA consulte"), ("consulta muy corta a Claude", "consulta muy corta a la IA"),
             (") van a Claude", ") van a la IA"), ("Claude solo si", "la IA solo si"), ("El visor de Claude no deja", "El navegador no deja")]:
    s = s.replace(a, b)

# 4) La capa de plataforma (Firebase) se carga antes que el agente.
stub = '''<script>/* El agente pide window.claude.use(...); kora.js lo resuelve con Firebase al entrar. */
window.claude = window.claude || { use: function(n){ return new Promise(function(r){ (window.__koraCola = window.__koraCola || []).push([n, r]); }); } };</script>
<script type="module" src="./kora.js"></script>
'''
html = f'''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d6b58">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="./icon-192.png">
<style>body{{margin:0}}[hidden]{{display:none!important}}img{{max-width:100%}}</style>
{stub}{head}
{s}
</body>
</html>
'''
(R / "index.html").write_text(html)
print("index.html listo:", len(html), "bytes")
