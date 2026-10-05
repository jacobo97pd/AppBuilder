# AppBuilder Studio

**Versión 0.1.5**

Entorno personal de desarrollo diseñado para móvil, tablet y escritorio. Interfaz en español, proyectos reales en disco, editor CodeMirror, agentes Codex/Claude con imágenes y archivos adjuntos, terminal, vista previa web y de Flutter, explorador de Firestore, asistente de publicación iOS y conexión a Codemagic.

## Ejecutar

Requisitos: Node.js 22.12 o superior, npm y Git.

```sh
npm ci
npm run build
npm start
```

Abre **http://127.0.0.1:4310**. Se crea automáticamente un proyecto editable, **Orbit Notes**. No necesitas claves para usar archivos, terminal, Git o vista previa. Para desarrollar AppBuilder: `npm run dev` y abre http://127.0.0.1:5173.

## Qué funciona

- Crear proyectos Web (HTML/CSS/JS) y React, o importar un repositorio existente de GitHub (o cualquier remoto HTTPS); persistencia en `.appbuilder/projects`.
- Explorar, crear, editar y guardar archivos con autocompletado. Protección de cambios sin guardar y conflictos con el archivo del servidor.
- Terminal por comandos con stdout/stderr real, historial persistente, cancelación de procesos secundarios, cuatro tareas simultáneas y límite de duración. **No es un PTY interactivo**: usa comandos no interactivos o encadena operaciones en un mismo comando; `cd` no persiste entre trabajos.
- Vista previa del HTML o React guardado, recompilación y consola. El iframe tiene origen aislado y no comparte credenciales ni almacenamiento con el editor. Las plantillas usan memoria cuando el navegador restringe localStorage; el estado de la app de ejemplo puede reiniciarse al actualizar la preview.
- Adjuntos para el agente: añade capturas, fotos o archivos (registros, PDF, JSON…) con los botones del mensaje, pegando una captura o arrastrándolos. Se guardan dentro del proyecto, en `.appbuilder/attachments` (oculto en el explorador, excluido de Git y borrado a los 14 días), hasta 10 por mensaje y 20 MB cada uno; las fotos grandes se reducen y las HEIC del iPhone pasan a JPEG. Codex recibe las imágenes directamente y Claude las abre con su herramienta de lectura.
- Tareas en segundo plano: el agente, la terminal y las compilaciones se ejecutan en el servidor, así que siguen aunque cierres la app o el móvil bloquee la pantalla. Al volver, el estudio recupera el proyecto, la pestaña, el borrador del mensaje y el modelo y esfuerzo elegidos para cada agente, y actualiza el estado de las tareas. Cada tarea del agente admite hasta 200 pasos y 60 minutos; si llega al límite, lo hecho queda guardado y basta con pedirle que continúe.
- Git: estado, diferencias por archivo, commits, restauración de archivos y checkpoint automático antes de tareas de IA. En proyectos importados: traer cambios (solo avance rápido), subir la rama actual y ver los commits pendientes en cada sentido.
- Integraciones reales mediante la cuenta ChatGPT iniciada en Codex o las claves que añadas en **Conexiones**. Nunca se simulan respuestas de proveedores.
- PWA instalable y proyectos Capacitor para Android/iOS con interfaz empaquetada y configuración de servidor HTTPS.

| Conector          | Implementado                                                                                       | Necesita configuración externa                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Codex             | SDK oficial, tareas, sesiones, archivos, comandos, cancelación y uso de tokens                     | Sesión ChatGPT de Codex en el servidor o API key de OpenAI; acceso al modelo elegido         |
| Claude            | Claude Code local o Agent SDK con API, tareas, sesiones y herramientas de archivos                 | Sesión claude.ai de Claude Code en el servidor o API key de Anthropic                        |
| Modelos           | Catálogo de la cuenta; esfuerzo según el modelo (Ultra en Codex, Muy alto y Máximo en Claude Code) | La velocidad disponible en estos adaptadores es estándar; no hay un selector rápido ficticio |
| Codemagic         | Iniciar/cancelar builds, consultar estados y enlaces a artefactos y registros                      | Token, repositorio registrado, App ID, workflow y rama remota                                |
| App Store Connect | Consulta de apps y asistente iOS: Bundle ID, perfil de App Store y `codemagic.yaml`                | Issuer ID, Key ID, clave .p8 con rol App Manager o Admin                                     |
| Google Play       | Cuenta de servicio, consulta de canales y versiones                                                | API habilitada, permisos y package name existente                                            |
| GitHub            | Elegir repositorios, importarlos (clonar) y sincronizar con pull/push                              | Token fine-grained con «Contents: Read and write», o una sesión de Git en el servidor        |
| Firebase          | Explorar colecciones y subcolecciones de Firestore; crear, editar y borrar documentos              | JSON de una cuenta de servicio del proyecto con acceso a Cloud Firestore                     |

AppBuilder no crea certificados de distribución, no crea la ficha de la app en App Store Connect (Apple no lo permite por API) ni sube binarios: el asistente iOS prepara lo demás y la firma y subida las hace Codemagic con el `codemagic.yaml` generado. Los proyectos creados desde plantilla no se publican en GitHub por sí solos: puedes añadir un remoto desde la terminal (`git remote add origin URL`) y, a partir de ahí, usar los botones de sincronización. Codemagic compila la rama del repositorio remoto, no los archivos sin subir del estudio.

## Trabajar con repositorios de GitHub

Pulsa **Importar de GitHub** (barra lateral, inicio o Proyectos). Si GitHub está conectado en **Conexiones**, eliges el repositorio de una lista; si no, pegas la dirección (`https://github.com/usuario/proyecto` o `usuario/proyecto`). El repositorio se clona **en el servidor** como una tarea con progreso que puedes cancelar; si falla, no deja restos.

- **Acceso**: con un token de GitHub guardado en Conexiones, AppBuilder lo envía como cabecera HTTP temporal solo a github.com; nunca se escribe en `.git/config` ni en los argumentos del proceso. Sin token, Git puede usar la sesión que ya tengas en ese ordenador (por ejemplo, Git Credential Manager), siempre sin ventanas interactivas.
- **Descarga ligera**: clona solo la última versión y omite los archivos de Git LFS. Se sugiere para repositorios grandes, como proyectos de Unity, cuando vas a editar código.
- **Sincronizar**: en la pestaña **Cambios** verás el remoto, los commits por subir y por traer, y los botones **Traer cambios** y **Subir a GitHub**. Puedes marcar que cada commit se suba automáticamente. Traer cambios solo avanza en línea recta (`--ff-only`); si tu copia y el remoto divergen, combínalos desde la terminal o con el agente.
- **Autoría**: los commits usan la identidad configurada en Git en el servidor (`user.name` y `user.email`); AppBuilder solo rellena una identidad propia si no existe ninguna. Los puntos de restauración que se crean antes de cada tarea del agente también son commits y se subirán con el resto.
- **Ajustes del proyecto** (icono de la barra de herramientas): muestra el origen, la carpeta en el servidor y permite eliminar la copia local. Lo que ya está en el remoto no se toca.

Solo se importan direcciones HTTPS. El explorador muestra hasta 20.000 elementos, con carpetas plegables, y el editor abre archivos de texto de hasta 2 MB.

## Apps de Flutter

Crea una app nueva con **Nuevo proyecto → App Flutter**: indica tu organización (por ejemplo `com.tuempresa`; el Bundle ID será `com.tuempresa.nombre_app`) y AppBuilder ejecuta `flutter create` para iOS, Android y web, guarda el primer commit y compila la vista previa. También puedes importar tus apps de GitHub.

La pestaña **Vista previa** detecta la app de Flutter en cualquier proyecto, en su raíz o en una subcarpeta (hasta dos niveles), y muestra un teléfono con la app compilada para web:

- Pulsa **Compilar vista previa**: el servidor ejecuta `flutter build web` en modo profile, que conserva los nombres para que los errores se entiendan, como una tarea que puedes seguir y cancelar. Si la app no tiene carpeta `web/`, se genera aparte y solo se copia `web/` al proyecto (aparecerá en Cambios).
- La app se sirve en un origen aislado, sin acceso al estudio, y comprimida con Brotli para que cargue rápido en el móvil. El almacenamiento del navegador (`shared_preferences`, la sesión de Firebase Auth…) funciona en memoria mientras la vista previa está abierta.
- Mientras arranca se indica en la pantalla; si no llega a arrancar, verás el error real y el botón **Pedir al agente que lo arregle**, que le pasa el error (o el registro de una compilación fallida) para que adapte el código a la web sin romper iOS ni Android.
- El botón de abrir en el navegador la muestra a pantalla completa.

Hace falta el SDK de Flutter en el PATH del usuario que ejecuta el servidor. Es la versión web de la app: los plugins que solo existen en Android o iOS (cámara nativa, notificaciones, compras, anuncios…) no funcionan en ella, y el inicio de sesión con ventanas emergentes de Firebase tampoco.

En **Builds → Abrir asistente** se prepara la publicación en App Store a partir de la conexión de App Store Connect:

1. Lee el Bundle ID y el nombre de la app del proyecto de Xcode de la app de Flutter (o escríbelos a mano).
2. Comprueba en Apple el Bundle ID, los certificados de distribución, el perfil de App Store y la ficha de la app.
3. Registra el Bundle ID y crea el perfil de App Store con un botón.
4. Genera un `codemagic.yaml` con el workflow `ios-release` (firma automática, IPA para TestFlight y, si la ficha de la app ya existe, número de build automático) y un APK de prueba. Guárdalo con un commit, súbelo y lanza el workflow en Codemagic.

El certificado de distribución se genera una sola vez desde Codemagic (Team settings → Code signing identities), que guarda su clave privada, y sirve para todas tus apps. La ficha de la app se crea una vez en App Store Connect; el asistente enlaza allí.

## Firebase

Conecta **Firebase** en Conexiones pegando el JSON de una cuenta de servicio (Consola de Firebase → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada). La página **Firebase** permite recorrer colecciones y subcolecciones, y crear, editar y borrar documentos de Cloud Firestore. Los tipos especiales se escriben como `{"$timestamp": "2026-01-31T10:00:00Z"}`, `{"$reference": "usuarios/ana"}`, `{"$geopoint": {...}}`, `{"$bytes": "..."}` o `{"$double": 3}`. Guardar sustituye el documento completo. Una cuenta de servicio tiene acceso total a la base de datos y no pasa por las reglas de seguridad: AppBuilder la guarda cifrada como el resto de credenciales.

## Conexiones y almacenamiento

Para usar Codex con tu plan ChatGPT, inicia sesión en **el ordenador que ejecuta el servidor** mediante `codex login` y pulsa **Usar cuenta ChatGPT** en Conexiones. AppBuilder fuerza ese modo de autenticación y no entrega una API key al SDK. La modalidad de API key es opcional y tiene facturación aparte. La sesión ChatGPT debe mantenerse activa en ese ordenador.

Para usar Claude en el panel de agentes sin una API key, instala Claude Code e inicia sesión con tu cuenta claude.ai **en el ordenador que ejecuta el servidor**. Pulsa **Usar Claude Code** en Conexiones. AppBuilder ejecuta el CLI oficial en ese ordenador, comprueba que la sesión sea claude.ai y no le pasa claves API ni tokens. Los modelos del selector son alias del CLI; la disponibilidad y los niveles de esfuerzo se comprueban al ejecutar. El agente local puede leer y editar archivos del proyecto; en Windows usa la Terminal de AppBuilder para comandos que requieran shell.

La opción **Usar API key** para Claude sigue disponible y tiene facturación independiente. AppBuilder no ofrece inicio de sesión de Claude ni gestiona sus tokens: debes iniciar sesión en Claude Code directamente en el ordenador. Anthropic restringe el inicio de sesión de claude.ai en productos de terceros sin aprobación previa, y sus condiciones de uso y facturación pueden cambiar; consulta la documentación oficial antes de depender de esta modalidad.

La terminal de AppBuilder también puede ejecutar comandos no interactivos del CLI oficial, por ejemplo `claude -p "Revisa este proyecto"`. Para trabajar desde el iPhone con la app oficial de Claude, ejecuta `powershell -ExecutionPolicy RemoteSigned -File scripts/start-claude-remote.ps1` en este ordenador. El script inicia Remote Control en `.appbuilder/projects` y elimina de ese proceso las variables que harían prevalecer la facturación API. La primera vez, Claude puede pedir que inicies sesión y confirmes que confías en esa carpeta.

Configura las demás claves en la interfaz o copia `.env.example` a `.env`. Las credenciales introducidas en la interfaz se cifran con AES-256-GCM. Por defecto, la clave maestra está en el mismo servidor: el cifrado no protege frente a alguien con acceso completo a ese equipo. Para separar la clave, configura `APPBUILDER_VAULT_KEY` con 32 bytes aleatorios en base64.

El servidor escucha solamente en `127.0.0.1`. El acceso remoto exige un token de al menos 32 caracteres, `APPBUILDER_PUBLIC_ORIGIN` HTTPS y un proxy TLS. La app nativa pide URL HTTPS y token; guarda la URL y, si marcas **Recordar en este dispositivo**, también el token en el almacenamiento de la app (si no, solo durante la sesión). Consulta [despliegue y móvil](docs/DEPLOYMENT.md).

**Es una versión para un solo usuario y proyectos de confianza.** Los comandos se ejecutan con los permisos del usuario del servidor. Las comprobaciones de rutas y el filtrado de variables no convierten la terminal en un contenedor aislado. Antes de ofrecerlo a terceros hay que incorporar autenticación por usuario, aislamiento de ejecución, límites de gasto, cuotas y operación de la infraestructura.

La vista previa es web: no emula las APIs nativas de Android/iOS. El service worker no almacena código de proyectos, respuestas API ni credenciales. Sin servidor no hay ejecución ni edición offline.

## Comprobaciones

```sh
npm run doctor
npm run check
npm test
npm run build
npm run test:e2e
```

Las pruebas del servidor usan archivos temporales y respuestas de proveedores simuladas en el test, sin inferencia ni builds de pago. Las pruebas del navegador utilizan un directorio de datos separado. En Windows se utiliza Chrome instalado; en CI se instala Chromium mediante Playwright.

Los iconos PNG de PWA/Android/iOS se exportan desde `public/icon.svg` con `node scripts/generate-icons.mjs`. Las fuentes se empaquetan localmente; la interfaz no depende de Google Fonts ni de un CDN.

## Estructura

```text
src/                Interfaz React, editor y paneles de trabajo
server/             API, proyectos, trabajos, preview e integraciones
public/             Manifiesto, icono y página sin conexión
android/ · ios/     Proyectos nativos Capacitor
tests/              Recorridos de navegador
docs/               Instrucciones de despliegue
codemagic.yaml      Checks web, APK debug e iOS simulador sin firma
.appbuilder/        Datos privados locales; excluidos de Git
```

## Referencias de integración

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [autenticación](https://learn.chatgpt.com/docs/auth) y [App Server](https://learn.chatgpt.com/docs/app-server).
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/quickstart).
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control).
- [Codemagic Builds API](https://docs.codemagic.io/rest-api/builds/).
- [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/).
- [Google Play Developer API](https://developers.google.com/android-publisher/api-ref/rest).
- [Capacitor](https://capacitorjs.com/docs).
