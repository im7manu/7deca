# Cambios

## 1.5.2

- Corregido: tras instalar, activar o configurar un plugin, sus botones aparecían repetidos en el detalle del envío (y sus extensiones se ejecutaban varias veces) hasta recargar la página.

## 1.5.1

- Corregido: el paquete de la 1.5.0 no incluía `plugins.js` y no arrancaba (las instalaciones volvían solas a la versión anterior). Ahora el paquete se comprueba arrancándolo antes de firmarlo.

## 1.5.0

- **Nuevo nombre: 7DeCA** (antes Gestor DeCA y eCMR), de la familia 7Factura, 7DeCA y 7Ruta. No cambia nada de los datos, las instalaciones ni las actualizaciones.
- **Plugins**: nueva página **Plugins** (administradores) para instalar desde el registro oficial (con comprobación SHA-256) o subiendo un `.tar.gz`, activar, desactivar, desinstalar y actualizar plugins, y reiniciar la aplicación. Se guardan en la carpeta de datos y sobreviven a las actualizaciones.
- Los plugins pueden añadir páginas al menú, secciones en Ubicaciones, en el formulario de envío y en el detalle del envío, rutas propias (`/api/p/<id>/`), campos extra en la API de integración y orígenes https en la política de seguridad de contenidos (por ejemplo, las teselas de un mapa).
- Clave de la instalación (`data/secreto.key`) para que los plugins guarden secretos cifrados (AES-256-GCM).
- `POST /api/ubicaciones` devuelve el `id` de la ubicación.
- Con el plugin Rutas y mapas, los campos de dirección (ubicaciones, empresas, contraparte y Mi entidad) sugieren direcciones mientras se escribe y rellenan el código postal, la población y la provincia.
- Para los plugins: `ctx.docs` (envíos y su PDF oficial), `ctx.lib` (pdfkit y QR), `ctx.extensionesDe` (funciones de otros plugins, p. ej. adjuntos extra), `ctx.alParar` y `ctx.reiniciar`; hueco al principio del formulario de envío y fila común de botones en el detalle (`DECA.accionDetalle`).
- Restauración de copias: si existe `data/restaurar/app.db` al arrancar, se coloca antes de abrir la base de datos (lo anterior se aparta en `data/antes-de-restaurar-<fecha>/`).
- La dirección de los scripts de un plugin cambia en cada instalación (el navegador no usa una copia antigua).
- Plugins oficiales: **Rutas y mapas**, **WhatsApp Web** (separado del WhatsApp de recuperación de contraseñas), **Envío por correo**, **Plantillas de transportes**, **Hoja de servicio**, **Calendario (.ics)** y **Copias automáticas**.
- Primer plugin oficial: **Rutas y mapas** (repositorio [gestor-deca-plugins](https://github.com/im7manu/gestor-deca-plugins)).

## 1.4.0

- **Integraciones**: nueva pestaña Usuarios › Integraciones para crear tokens de solo lectura. Permiten que otra aplicación lea los envíos, empresas, vehículos y conductores, por ejemplo el plugin «Gestor DeCA» de Facturador para facturar los envíos. Cada token se muestra una vez, se guarda solo su hash, queda en la auditoría y se puede revocar al momento.
- API de integración: `GET /api/integracion/v1/estado`, `/envios` (filtros por fechas, tipo y estado), `/empresas`, `/vehiculos` y `/conductores`, con `Authorization: Bearer <token>` y un límite de 120 peticiones por minuto.

## 1.3.0

- Passkeys (WebAuthn): acceso sin contraseña desde «Entrar con passkey»; gestión en la nueva página «Mi cuenta»; el administrador puede quitar las passkeys de un usuario.
- Recuperación de la contraseña con un código enviado por WhatsApp al teléfono verificado. Desbloquea la cuenta y cierra las demás sesiones.
- Verificación obligatoria del teléfono por WhatsApp al entrar (si el servidor tiene `WHATSAPP_API`).
- «Mi cuenta»: teléfono, passkeys y cambio de la propia contraseña.
- Usuarios: teléfono y su verificación, passkeys, cuentas bloqueadas y opción de desbloquearlas.
- Una cuenta bloqueada por intentos fallidos puede seguir entrando con passkey o restablecer la contraseña. Cambiar la contraseña desde Usuarios también la desbloquea.
- Actualizaciones firmadas con Ed25519 (paquete `deca-ecmr-<versión>.tar.gz` + `.sig`, con las dependencias incluidas) publicadas por GitHub Actions al subir una etiqueta.
- Horario de instalación automática configurable.
- Variable `HOST` para elegir la interfaz de escucha. Pruebas automáticas (`npm test`).
- Corregido: tras iniciar sesión, la primera pantalla podía cerrar un aviso recién abierto.
