# Plugins de Gestor DeCA y eCMR

Desde la versión 1.5.0, Gestor DeCA admite plugins: carpetas con un `plugin.json`, código de servidor opcional y scripts para la interfaz. Los plugins oficiales están en [im7manu/gestor-deca-plugins](https://github.com/im7manu/gestor-deca-plugins).

> Un plugin ejecuta código con los mismos permisos que la aplicación. Instala solo plugins de fuentes en las que confíes.

## Dónde se guardan

- Código: `data/plugins/<id>/` (o la carpeta de `DECA_PLUGINS`).
- Datos propios: `data/plugins-datos/<id>/` (`ctx.dataDir`) y la tabla `plugin_ajustes` (`ctx.getAjuste` / `ctx.setAjuste`).
- Al estar en la carpeta de datos, las actualizaciones de la aplicación no los tocan. Desinstalar un plugin borra su código, pero no sus datos.

## plugin.json

```json
{
  "id": "mi-plugin",
  "nombre": "Mi plugin",
  "version": "1.0.0",
  "descripcion": "Qué hace",
  "autor": "im7manu",
  "app_min": "1.5.0",
  "server": "server.mjs",
  "ui": { "scripts": ["ui/plugin.js"], "estilos": ["ui/plugin.css"] },
  "csp": { "img": ["https://tile.openstreetmap.org"] }
}
```

- `id`: minúsculas, números y guiones (debe coincidir con el del registro).
- `app_min`: versión mínima de Gestor DeCA; si la instalación es más antigua, no se instala.
- `ui.scripts` / `ui.estilos`: se cargan en la aplicación tras iniciar sesión (en orden).
- `csp`: orígenes `https://` extra por tipo (`img`, `script`, `connect`, `style`, `font`, `frame`) mientras el plugin esté activo.

## server.mjs

```js
export function register(ctx) {
  ctx.router.get('/hola', (req, res) => res.json({ hola: req.u.nombre })); // /api/p/mi-plugin/hola (con sesión)
  ctx.extender('integracion.envio', ({ envio, datos }) => ({ mi_campo: 1 }));
  ctx.hooks.on('doc.guardado', ({ doc, datos, nuevo }) => { /* ... */ });
}
```

| `ctx.` | Para qué |
|---|---|
| `router` | Router de Express en `/api/p/<id>/` (solo con sesión; `req.u` es el usuario) |
| `adm`, `need(permiso)`, `can(usuario, permiso)` | Comprobar rol y permisos |
| `db` | Base de datos (`node:sqlite`). Usa tablas propias con el prefijo `plugin_<id>_` |
| `getAjuste(clave, def)`, `setAjuste(clave, valor)` | Ajustes en JSON |
| `cifrar(texto)`, `descifrar(texto)` | Secretos cifrados con la clave de la instalación |
| `logAudit(usuario, ip, accion, detalle, severidad)` | Auditoría |
| `ajustes()` | Datos de Mi entidad |
| `extender(punto, fn)`, `hooks.on(evento, fn)` | Puntos de extensión y eventos (abajo) |
| `cada(ms, fn)` | Tarea periódica que se detiene al desactivar el plugin |
| `alParar(fn)` | Función que se ejecuta al desactivar o actualizar el plugin (cerrar conexiones…) |
| `extensionesDe(punto)` | Funciones que ofrecen otros plugins en un punto, `[{ id, fn }]` (p. ej. `documentos.extra`) |
| `docs` | Envíos: `obtener(id)`, `pdf(id)` (ruta del PDF oficial), `ve(usuario, id)`, `gestiona(usuario, id)` |
| `lib` | `PDFDocument` (pdfkit) y `QR` (qrcode) |
| `reiniciar()` | Reinicia la aplicación (necesita supervisor) |
| `dataDir`, `dir`, `manifest`, `version` | Carpetas, `plugin.json` y versión de la aplicación |

### Puntos de extensión

| Punto | Firma | Para qué |
|---|---|---|
| `doc.datos` | `(datos, { tipo, nuevo }) => datos` | Ajustar los datos de un envío nuevo antes de guardarlo (p. ej. leer un campo oculto del formulario) |
| `integracion.envio` | `({ envio, datos, doc }) => objeto` | Campos extra de cada envío en la API de integración |

### Eventos

| Evento | Datos |
|---|---|
| `doc.guardado` | `{ doc, datos, nuevo, cambios, usuario }` (al crear o modificar un envío) |
| `ubicacion.guardada` | `{ id, body, usuario }` (`body` incluye los campos que añada el plugin al formulario) |
| `ubicacion.borrada` | `{ id }` |

## Interfaz

Los scripts usan `window.DECA`:

```js
DECA.extender('ubicacion.form', ({ form, cont, ubicacion }) => { cont.innerHTML = '...'; });
DECA.pagina({ id: 'mi-pagina', label: 'Mi página', icon: 'map', show: () => DECA.perm('ubicaciones'), render(view) { view.innerHTML = DECA.head('Título', 'Subtítulo'); } });
```

| Punto | Argumento |
|---|---|
| `ubicacion.form` | `{ form, cont, ubicacion }`: `cont` es un hueco al final del formulario que comparten todos los plugins: añade tu propio elemento (`cont.appendChild`) en lugar de sustituir su contenido. Los campos con `name` que añadas llegan en `body` al evento `ubicacion.guardada` |
| `ubicacion.guardada` | `{ id, body }` (en el navegador, tras guardar) |
| `ubicaciones.lista` | `{ view, ubicaciones }`: cada tarjeta lleva `data-ubicacion="<id>"` |
| `envio.form` | `{ form, cont, inicio, estado }`: se llama cada vez que se redibuja el formulario. `cont` es un hueco al final e `inicio`, otro al principio. Los campos con `name` dentro de `cont` se envían con los datos del envío. Para rellenar el formulario, pon `DECA.state.dup = { tipo, datos }` y llama a `DECA.renderApp()` |
| `envio.detalle` | `{ cont, doc }` en la ventana de detalle del envío |

En `envio.detalle`, usa `DECA.accionDetalle(cont, html)` para añadir tu botón a la fila común de acciones.

También ofrece `DECA.api`, `DECA.toast`, `DECA.esc`, `DECA.I(icono)`, `DECA.perm`, `DECA.go`, `DECA.head`, `DECA.fieldHtml`, `DECA.showFormModal`, `DECA.state` y `DECA.ubicaciones`.

## Publicar

1. Empaqueta: `tar -czf mi-plugin-1.0.0.tar.gz -C mi-plugin .` (o `node scripts/empaquetar.mjs <id>` en gestor-deca-plugins).
2. Publica el paquete en una Release y añade al `registry.json` su `url` (https) y su `sha256`.
3. Para probar sin publicar: **Plugins › Instalar desde un archivo**.

Variables para desarrollo: `DECA_PLUGINS` (carpeta), `DECA_PLUGINS_REGISTRY` (otro registro) y `DECA_PLUGINS_DEV_HTTP=1` (permitir http, solo en pruebas).
