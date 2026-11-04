# Agente contable (Kora)

App propia del agente contable de Kotic: libros por evento, boletería, barra, personal, socios, métricas e informes, con **Kora**, la asistente por voz.

- **Datos:** Firebase Firestore (proyecto `kora-agente`). Cada libro vive en `libros/{libro}/…`; se pueden tener varios libros (Kotic y otras empresas).
- **Personas:** entran con Google. El dueño invita por correo y asigna el rol (Administrador, Contador, Taquilla, Barra, Solo lectura). Las reglas de `firestore.rules` hacen cumplir el rol en la base de datos.
- **IA:** Kora usa Gemini por Firebase AI Logic (nivel gratis). Se apaga con el botón «IA» de la barra superior.
- **Fotos de soportes:** se guardan comprimidas dentro de Firestore (no necesita Storage de pago).

## Archivos
| Archivo | Qué es |
|---|---|
| `index.html` | La app (generada; no editar a mano) |
| `kora.js` | Firebase + la capa que conecta el agente con la base (generado) |
| `src/agente/` | Código del agente contable |
| `src/kora-shim.js` | Inicio de sesión, libros, invitaciones, base de datos e IA |
| `src/firebase-config.js` | Configuración pública del proyecto de Firebase |
| `firestore.rules` | Reglas de seguridad por rol |
| `tools/build.py` | Arma `index.html` desde `src/agente/` |

## Volver a generar
```
npm install
npm run build
```

## Publicar
Cada `push` a `main` publica la app con GitHub Actions (`.github/workflows/pages.yml`).
Las reglas se publican pegando `firestore.rules` en Firebase → Firestore Database → Reglas → Publicar (o `npx firebase-tools deploy --only firestore:rules`).
El dominio donde queda la app debe estar en Firebase → Authentication → Configuración → Dominios autorizados.
