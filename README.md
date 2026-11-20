<img width="75" height="75" alt="Icono de 7DeCA" src="https://github.com/user-attachments/assets/40182b76-2a7d-40a5-872e-007ea6214417" /> <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" xmlns:c2pa="http://c2pa.org/manifest"> <rect width="64" height="64" rx="12" fill="#0f6cbd"/><path d="M18 16h14a16 16 0 0 1 0 32H18z" fill="#fff"/></svg>
# 7DeCA 

Plataforma integral para la emisión, gestión y trazabilidad documental de **DeCA** (Documento Electrónico de Control Administrativo) y **eCMR** (Carta de porte electrónica internacional), con interfaz moderna, backend en Node.js, base de datos nativa SQLite y arquitectura de seguridad blindada para despliegues en producción.

---
<img width="960" alt="Interfaz inicial de 7DeCA" src="https://github.com/user-attachments/assets/1bf3c7a7-28a6-4056-b6eb-798301ed5f1b" />

## 🚀 Primer Arranque y Registro Inicial (Setup Wizard)

La aplicación **ya no contiene contraseñas maestras por defecto ni puertas traseras**.

La primera vez que se ejecuta la aplicación, el sistema detecta de forma automática que no existen usuarios registrados y activa el **Asistente de Configuración Inicial**:

1. Arranca la aplicación con Node (requiere Node >= 22.13):
   ```bash
   npm install
   npm start
   ```
2. Abre en tu navegador `http://localhost:9000` (o la IP/dominio configurado).
3. Aparecerá la pantalla de **Configuración Inicial y Registro**:
   - **Superadministrador**: Nombre completo, nombre de usuario alfanumérico, email de seguridad y contraseña robusta.
   - **Medidor de Seguridad en tiempo real**: Se exige una contraseña de al menos 10 caracteres que combine mayúsculas, minúsculas, números y caracteres especiales (`!@#$%...`).
   - **Datos de Mi Entidad**: Configura la razón social del transportista, NIF/CIF, domicilio y autorización de transporte (ej. MDPE).
4. Al pulsar **Finalizar instalación y entrar**, el sistema:
   - Aplica hashing criptográfico mediante `scrypt` con sal única de 32 bytes y clave de 64 bytes.
   - Bloquea de forma atómica y permanente el endpoint de instalación para evitar registros posteriores no autorizados.
   - Genera una sesión segura con token aleatorio de 256 bits y cookie `HttpOnly`.
   - Inicia sesión automáticamente en el cuadro de mando.

Para permitir el acceso a otros equipos de la red local o en producción:
```bash
BASE_URL=http://IP-DEL-SERVIDOR:9000 npm start
```

En producción, despliega siempre detrás de HTTPS con tu dominio:
```bash
BASE_URL=https://tudominio.com npm start
```

---

## 🛡️ Medidas de Seguridad Implementadas (Blindaje de Despliegue)

Para garantizar un entorno impenetrable en producción, se han incorporado las siguientes capas de seguridad:

| Capa de Seguridad | Implementación técnica | Protección frente a |
|---|---|---|
| **Criptografía de Contraseñas** | Algoritmo `scrypt` (coste de memoria y CPU `N: 16384, r: 8, p: 1`) con sal aleatoria de 32 bytes (`crypto.randomBytes(32)`) y clave derivada de 64 bytes. | Cracking por fuerza bruta, diccionarios, tablas arcoíris y aceleradores GPU/ASIC. |
| **Mitigación de Timing Attacks** | Verificación constante contra hash ficticio en intentos de login con usuarios inexistentes y comparación en tiempo constante con `crypto.timingSafeEqual`. | Enumeración de usuarios por análisis de tiempos de respuesta en red. |
| **Política Estricta de Contraseñas** | Mínimo 10 caracteres obligatorios con mayúsculas, minúsculas, dígitos y símbolos tanto en setup inicial como en creación/edición de usuarios. | Contraseñas triviales o fáciles de adivinar. |
| **Protección Anti-Fuerza Bruta** | Bloqueo temporal de cuentas tras 5 intentos fallidos (15 minutos) y limitación de tasa por dirección IP en memoria. El bloqueo no impide entrar con passkey ni restablecer la contraseña por WhatsApp. | Ataques masivos de adivinación de contraseñas. |
| **Passkeys (WebAuthn)** | Acceso sin contraseña con la huella, la cara o el PIN del dispositivo (credenciales detectables, `@simplewebauthn/server`). La clave privada nunca sale del dispositivo. | Phishing, robo y reutilización de contraseñas. |
| **Recuperación por WhatsApp** | Código de 6 cifras al teléfono verificado: 10 minutos de validez, 5 intentos, solo se guarda su hash, un envío por minuto y 5 por hora. Misma respuesta exista o no el usuario. Aviso por WhatsApp cuando cambia la contraseña. | Cuentas bloqueadas sin salida y enumeración de usuarios. |
| **Actualizaciones firmadas** | Los paquetes se firman con Ed25519 y la aplicación rechaza cualquiera cuya firma no cuadre con la clave pública incluida. | Instalación de código manipulado. |
| **Gestión de Sesiones** | Identificadores de sesión criptográficos de 256 bits (`crypto.randomBytes(32)`). Cookies marcadas con `HttpOnly`, `SameSite=Lax` y `Secure` condicional. | Robo de sesión por XSS, fijación de sesión y secuestro. |
| **Cabeceras HTTP Defensivas** | `Content-Security-Policy` restrictiva, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`. Ocultación de cabecera `X-Powered-By`. | Clickjacking, inyección XSS, sniffing MIME y ataques de canal lateral. |
| **Defensa contra CSRF** | Validación estricta del origen (`Origin`/`Referer`) en todas las peticiones con métodos mutantes (`POST`, `PUT`, `PATCH`, `DELETE`). | Cross-Site Request Forgery desde páginas maliciosas externas. |
| **Protección Path Traversal** | Validación estricta del formato de tokens de documentos (`^[a-f0-9]{32,64}$`) y verificación de confinamiento en el directorio `data/pdf/` mediante `path.resolve`. | Lectura no autorizada de archivos del sistema operativo (`../../etc/passwd`). |
| **Auditoría de Seguridad** | Tabla interna `audit_logs` que registra todos los accesos, logins fallidos, bloqueos, modificaciones de usuarios y cambios de documentos con usuario, IP, fecha y nivel de severidad. | Trazabilidad forense y cumplimiento normativo de seguridad. |

---

## 📋 Estructura y Navegación del Sistema

| Pestaña | Función implementada | API Backend |
|---|---|---|
| **Inicio** | Cuadro de mando, envíos en curso, alertas de ITV caducada y borradores pendientes | `/api/docs-todos`, `/api/vehiculos` |
| **Envíos** | Gestión DeCA y eCMR, filtros por estado (`borrador`, `emitido`, `cerrado`, `anulado`), visor PDF integrado, QR público y trazabilidad de rectificaciones | `/api/docs-todos`, `/api/docs`, `/api/docs/:id`, `/api/docs/:id/estado`, `/api/qr` |
| **Empresas** | Directorio de clientes, cargadores y transportistas con sincronización de catálogo | `/api/empresas`, `/api/clientes` |
| **Medios de transporte** | Flota de vehículos (tractoras, rígidos, remolques) con ITV y conductores activos/inactivos | `/api/vehiculos`, `/api/conductores` |
| **Mercancías** | Catálogo habitual con códigos LER/NC y unidades de medida | `/api/mercancias` |
| **Ubicaciones** | Puntos de carga, descarga y almacenes para autocompletar trayectos | `/api/ubicaciones` |
| **Usuarios y Seguridad** | Gestión de usuarios, asignación de roles/permisos, y visor de **Auditoría de Seguridad** | `/api/usuarios`, `/api/audit-logs` |
| **Mi entidad** | Datos fiscales del transportista efectivo aplicados a nuevos documentos | `/api/ajustes` |

---

## 📦 Base de Datos y Persistencia

- Base de datos SQLite gestionada mediante la API nativa de Node.js `node:sqlite` en `data/app.db`.
- Los documentos PDF oficiales generados se almacenan en `data/pdf/<token>.pdf`.
- La URL pública accesible mediante QR `/d/<token>` permite la comprobación en carretera por las autoridades de tráfico e inspección de transportes sin necesidad de credenciales.

## Novedades de la versión 1.5.0: plugins

7DeCA admite **plugins**: funciones opcionales que el administrador instala desde la página **Plugins** del menú. Se descargan del registro oficial ([im7manu/7deca-plugins](https://github.com/im7manu/7deca-plugins)) y se comprueba su SHA-256 antes de instalarlos; también se puede subir un `.tar.gz`. Se guardan en `data/plugins/` (con sus datos en `data/plugins-datos/`), así que las actualizaciones de la aplicación no los borran.

El primero es **7Ruta**: busca las ubicaciones o pon sus coordenadas y velas en el mapa, muestra la ruta de cada envío (camión o coche, evitando peajes, autopistas o ferris) y guarda los km. 7Factura los recibe por la API de integración (campo `ruta`) para **facturar por kilómetro**. Funciona con OpenRouteService (gratis) o con Google Maps (con la clave del administrador).

Un plugin funciona con los mismos permisos que la aplicación: instala solo los del registro oficial o de autores de confianza. Cómo crear uno: [`docs/plugins.md`](docs/plugins.md).

## Novedades de la versión 1.4.0: integración con 7Factura

En **Usuarios › Integraciones** el administrador crea un token de **solo lectura** para otra aplicación. Con él, el plugin **7DeCA** de [7Factura](https://github.com/im7manu/7factura) lista los envíos emitidos o cerrados y los convierte en una factura en borrador (por viaje o por tonelada), recuerda cuáles están facturados y copia clientes, vehículos y conductores.

El token se muestra una sola vez (solo se guarda su hash), no permite modificar nada, queda en la auditoría (`INTEGRACION_*`) y se puede revocar al momento.

| Petición (con `Authorization: Bearer deca_…`) | Devuelve |
|---|---|
| `GET /api/integracion/v1/estado` | Versión y empresa |
| `GET /api/integracion/v1/envios?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&tipo=deca\|ecmr&estado=emitido,cerrado` | Envíos con cliente, ruta, mercancía, peso, matrícula, conductor y enlace al PDF. Con el plugin 7Ruta (1.5.0), también `ruta` (km, duración, opciones) y `puntos` (coordenadas de carga y descargas) |
| `GET /api/integracion/v1/empresas`, `/vehiculos`, `/conductores` | Catálogo |

## Novedades de la versión 1.3.0

- **Passkeys**: cada usuario puede crear passkeys en **Mi cuenta** y entrar con «Entrar con passkey», sin escribir usuario ni contraseña. Tras entrar con contraseña, la aplicación le propone crear una. El administrador puede quitar las passkeys de un usuario (p. ej. si pierde el móvil).
- **Recuperar la contraseña por WhatsApp**: «¿Has olvidado tu contraseña?» envía un código al teléfono verificado del usuario. Con él se pone una contraseña nueva, se desbloquea la cuenta, se cierran las demás sesiones y se entra directamente.
- **Teléfono verificado obligatorio**: si el servidor tiene WhatsApp configurado, cada usuario verifica su móvil con un código la próxima vez que entre. Hasta entonces no puede usar la aplicación.
- **Mi cuenta**: nueva página para todos los usuarios con sus passkeys, su teléfono y el cambio de contraseña.
- **Usuarios**: se ve el teléfono de cada usuario y si está verificado, sus passkeys y si la cuenta está bloqueada, con opción de desbloquearla al guardar.
- **Actualizaciones firmadas** (Ed25519) y horario de instalación automática configurable.

### Configurar WhatsApp

Los mensajes se envían a través de un puente HTTP compatible con [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) (`POST /api/send` con `{ "recipient": "34600000000", "message": "…" }`) desde el número vinculado a ese puente.

| Variable | Uso |
|---|---|
| `WHATSAPP_API` | Dirección del puente, p. ej. `http://127.0.0.1:8765`. Sin ella, la recuperación por WhatsApp no está disponible y no se exige verificar el teléfono. |
| `WHATSAPP_EXIGIR=0` | Mantiene la recuperación por WhatsApp pero no obliga a verificar el teléfono. |
| `RP_ID` / `RP_ORIGIN` | Solo si las passkeys deben usar un dominio distinto del de `BASE_URL`. |
| `HOST` | Interfaz en la que escucha el servidor (p. ej. `127.0.0.1`). |

Mensaje que recibe el usuario (y, aparte, el código solo, para copiarlo con una pulsación larga):

> Este es tu código para restablecer la contraseña de 7DeCA: 286472. ¿No has sido tú? Ignora este mensaje.

Las passkeys funcionan solo por HTTPS (o en `localhost`) y van ligadas al dominio de `BASE_URL`: si cambias de dominio, los usuarios tendrán que crearlas de nuevo.

## Novedades de la versión 1.2.0

- **Asignar documentos a usuarios**: al crear un DeCA o eCMR (o después, con «Asignar»/«Reasignar») se puede elegir el usuario que hará el transporte. El administrador y quienes tienen permiso de ver o crear documentos siguen viéndolo todo; el usuario asignado, aunque no tenga ningún permiso, ve solo sus documentos y puede **cerrarlos él mismo** al terminar (no puede modificarlos, anularlos ni reasignarlos).
- **Emitir borradores**: los borradores se pueden emitir más tarde con el botón «Emitir» (antes se quedaban en borrador para siempre). Los cambios de estado siguen un orden fijo: borrador → emitido → cerrado, o anulado. Cerrado y anulado son definitivos y ya no se pueden modificar desde la API.
- **Marca de agua** «BORRADOR» o «ANULADO» en el PDF, para que nadie que escanee el QR los confunda con un documento válido.
- **Duplicar envío**: crea un envío nuevo con los datos de otro y la fecha de hoy.
- **Exportar a Excel** (CSV) la lista de envíos que se está viendo.
- **Copia de seguridad** de la base de datos con un clic (administradores, en Usuarios). Los PDF se regeneran solos a partir de ella al arrancar.
- **Sugerencias de mercancía** desde el catálogo al escribir.
- El **nº de albarán** y las **observaciones del transportista** ahora aparecen en el PDF y se pueden modificar (antes el albarán se pedía pero no se guardaba en el documento).
- **Corregido**: quien podía crear documentos sin tener permiso de gestionar empresas o transporte veía vacíos los desplegables de contraparte y vehículo y no podía emitir nada.
- **Seguridad**: las eliminaciones del catálogo quedan en la auditoría; cookie de cierre de sesión con `HttpOnly`; nueva variable `TRUST_PROXY` (ver abajo).
- Detalles: saludo según la hora, la app se puede instalar en el móvil (manifest enlazado) y las direcciones largas ya no descuadran la pantalla de inicio.
- **Actualizaciones automáticas y seguras** desde las Releases de GitHub, con copia de seguridad previa y vuelta atrás automática si la nueva versión falla (ver «Actualizaciones» más abajo).
- **Guía de uso en PDF** para usuarios sin conocimientos técnicos: [`docs/Guia-de-uso-DeCA-eCMR.pdf`](docs/Guia-de-uso-DeCA-eCMR.pdf).

## 🔄 Actualizaciones

La aplicación comprueba cada hora si hay una versión nueva publicada en las **Releases** de GitHub (`im7manu/7deca`). Los administradores la ven en **Usuarios › Actualizaciones** y en la campana de avisos, y pueden instalarla con un clic o dejar activada la instalación automática en el horario que elijan (por defecto, de 3:00 a 5:00).

**Cómo se instala sin riesgo:**

1. Se descarga el paquete firmado de la versión nueva y se comprueba su **firma digital Ed25519** con la clave pública incluida en la aplicación (`clave-actualizaciones.pem`); si no cuadra, se rechaza sin abrirlo. Después se extrae en `data/actualizaciones/` y se verifica: que es esta aplicación, que la versión coincide con la publicada y es más reciente, que el código no tiene errores de sintaxis, que no contiene enlaces simbólicos y que la versión de Node del servidor es suficiente. Después se preparan sus dependencias (se copian si no cambian, o se instalan con `npm ci`). Todo esto ocurre con la aplicación en marcha.
2. Se hace una **copia de seguridad** de la base de datos en `data/copias/<fecha>-<de>-a-<a>/`.
3. La aplicación se reinicia. El **supervisor** (`scripts/supervisor.js`) guarda el código actual en esa misma copia y coloca el nuevo. La carpeta `data/` (base de datos y PDF) no se toca nunca.
4. La nueva versión tiene un **periodo de prueba** (60 s). Si se cae o no responde durante ese periodo, el supervisor **restaura solo** el código y la base de datos anteriores; la base de datos de la versión fallida se guarda también en la copia.

Se conservan las 3 últimas copias, descargables desde la propia pantalla. Todo queda en la auditoría (`ACTUALIZACION_*`).

**Requisito:** arrancar con `npm start`, que lanza el supervisor. Con `node server.js` la app funciona, pero no puede instalar actualizaciones (la pantalla lo indica). Con systemd:

```ini
# /etc/systemd/system/deca-ecmr.service
[Unit]
Description=7DeCA
After=network-online.target

[Service]
WorkingDirectory=/opt/7deca
ExecStart=/usr/bin/node scripts/supervisor.js
Environment=PORT=9000 BASE_URL=https://tudominio.com TRUST_PROXY=1
Restart=always

[Install]
WantedBy=multi-user.target
```

El servicio necesita permiso de escritura sobre la carpeta de la aplicación (no solo sobre `data/`), porque el supervisor sustituye sus archivos.

**Con Docker:** usa el `Dockerfile` y `docker-compose.example.yml` incluidos. La clave es montar la carpeta completa del proyecto en `/app` (no solo `data/`): si el código está solo dentro de la imagen, el actualizador no puede sustituirlo, y además los cambios se perderían al recrear el contenedor. La carpeta debe pertenecer al usuario con UID 1000 (el usuario `node` de la imagen).

**Cómo publicar una versión nueva:**

1. Sube `version` en `package.json` (p. ej. `1.3.1`), añade las novedades a `CHANGELOG.md` y fusiona los cambios en `main`.
2. Crea y sube la etiqueta: `git tag v1.3.1 && git push origin v1.3.1` (debe coincidir exactamente con `package.json`).
3. El flujo de GitHub Actions «Publicar versión» pasa las pruebas, crea el paquete con `npm run release`, lo firma con el secreto `DECA_CLAVE_FIRMA` y publica la Release con `deca-ecmr-<versión>.tar.gz` y su `.sig`.
4. Las instalaciones la detectarán en la siguiente comprobación (como mucho, una hora).

Una Release sin paquete firmado no se instala. Los borradores y las *pre-releases* se ignoran. La clave privada de firma se guarda fuera del repositorio (`~/.gestor-deca/clave-firma-actualizaciones.pem`); si se pierde, hay que generar otra y publicar la nueva clave pública en una versión instalada a mano.

**Variables de entorno opcionales:** `UPDATE_DISABLED=1` (desactiva las actualizaciones), `UPDATE_REPO` (otro repositorio), `UPDATE_HEALTH_SECONDS` (duración del periodo de prueba), `UPDATE_KEEP_BACKUPS` (número de copias que se conservan).

> Si la aplicación está instalada como un clon de git, tras una actualización `git status` mostrará los archivos cambiados. Es normal: el código coincide con la Release instalada.

> Las instalaciones de la versión 1.1.0 o anteriores no incluyen el actualizador: hay que actualizarlas a mano una vez (copiar los archivos nuevos y arrancar con `npm start`). A partir de ahí se actualizan solas.

## 🌐 Detrás de un proxy inverso (nginx, Caddy, Cloudflare…)

Arranca con `TRUST_PROXY=1` para que la aplicación vea la IP real de cada usuario:

```bash
BASE_URL=https://tudominio.com TRUST_PROXY=1 npm start
```

Sin esta opción todos los usuarios comparten la IP del proxy, de modo que la limitación de intentos de acceso por IP podría bloquear el inicio de sesión de todo el mundo a la vez y la auditoría registraría siempre la misma IP.

## Novedades de la versión 1.1.0

- **Ubicaciones**: el nombre ya no es único (una misma sede puede ser carga y descarga). Solo se rechaza una ubicación idéntica en nombre, tipo y dirección. Nuevo tipo «Carga y descarga». La base de datos antigua se migra sola al arrancar.
- **Sugerencias al escribir** en destinatario, lugar de carga y lugares de descarga (con teclado: flechas, Intro, Esc). Se ordenan según el tipo de ubicación más adecuado a cada campo.
- **Varios lugares de descarga/entrega** en DeCA y eCMR; el PDF los lista todos («Lugar de descarga 1 de 3», …).
- **Modificar un documento emitido**: matrícula, remolque y conductor usan un selector con «Otro…»; el conductor se separa en nombre y DNI/NIF; origen, destinatario y descargas usan las sugerencias. Los documentos antiguos se leen y se muestran con el formato nuevo sin tocar lo guardado.
- **Modo oscuro** automático según el tema del dispositivo.
- **Avisos** (campana): ITV a 30 días, a 7 días o caducada, y DeCA emitidos sin cambios desde hace más de 12 h. Con «Activar avisos del sistema» se muestran también como notificaciones del dispositivo mientras la aplicación esté abierta (requiere HTTPS o localhost).

---

Creado con ❤️ por im7manu
