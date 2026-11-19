# Cambios

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
