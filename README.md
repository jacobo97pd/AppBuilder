# AppBuilder Studio

**Versión 0.1.1**

Entorno personal de desarrollo diseñado para móvil, tablet y escritorio. Interfaz en español, proyectos reales en disco, editor CodeMirror, agentes Codex/Claude, terminal, vista previa web y conexión a Codemagic.

## Ejecutar

Requisitos: Node.js 22.12 o superior, npm y Git.

```sh
npm ci
npm run build
npm start
```

Abre **http://127.0.0.1:4310**. Se crea automáticamente un proyecto editable, **Orbit Notes**. No necesitas claves para usar archivos, terminal, Git o vista previa. Para desarrollar AppBuilder: `npm run dev` y abre http://127.0.0.1:5173.

## Qué funciona

- Crear proyectos Web (HTML/CSS/JS) y React; persistencia en `.appbuilder/projects`.
- Explorar, crear, editar y guardar archivos con autocompletado. Protección de cambios sin guardar y conflictos con el archivo del servidor.
- Terminal por comandos con stdout/stderr real, historial persistente, cancelación de procesos secundarios, cuatro tareas simultáneas y límite de duración. **No es un PTY interactivo**: usa comandos no interactivos o encadena operaciones en un mismo comando; `cd` no persiste entre trabajos.
- Vista previa del HTML o React guardado, recompilación y consola. El iframe tiene origen aislado y no comparte credenciales ni almacenamiento con el editor. Las plantillas usan memoria cuando el navegador restringe localStorage; el estado de la app de ejemplo puede reiniciarse al actualizar la preview.
- Git: estado, diferencias por archivo, commits, restauración de archivos y checkpoint automático antes de tareas de IA.
- Integraciones reales mediante la cuenta ChatGPT iniciada en Codex o las claves que añadas en **Conexiones**. Nunca se simulan respuestas de proveedores.
- PWA instalable y proyectos Capacitor para Android/iOS con interfaz empaquetada y configuración de servidor HTTPS.

| Conector          | Implementado                                                                          | Necesita configuración externa                                                               |
| ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Codex             | SDK oficial, tareas, sesiones, archivos, comandos, cancelación y uso de tokens        | Sesión ChatGPT de Codex en el servidor o API key de OpenAI; acceso al modelo elegido         |
| Claude            | Claude Code local o Agent SDK con API, tareas, sesiones y herramientas de archivos    | Sesión claude.ai de Claude Code en el servidor o API key de Anthropic                        |
| Modelos           | Catálogo de la cuenta; esfuerzo únicamente cuando hay metadatos del proveedor/runtime | La velocidad disponible en estos adaptadores es estándar; no hay un selector rápido ficticio |
| Codemagic         | Iniciar/cancelar builds, consultar estados y enlaces a artefactos y registros         | Token, repositorio registrado, App ID, workflow y rama remota                                |
| App Store Connect | Autenticación JWT y consulta de apps                                                  | Issuer ID, Key ID, clave .p8 y permisos de la cuenta                                         |
| Google Play       | Cuenta de servicio, consulta de canales y versiones                                   | API habilitada, permisos y package name existente                                            |
| GitHub            | Consulta de repositorios                                                              | Token con permisos apropiados                                                                |

La publicación final en tiendas, gestión completa de certificados, firma y subida de binarios no están implementadas. Los proyectos locales tampoco se publican ni sincronizan automáticamente con GitHub: puedes usar Git desde la terminal para configurar un remoto y hacer push. Codemagic compila la rama del repositorio remoto, no los archivos sin subir del estudio.

## Conexiones y almacenamiento

Para usar Codex con tu plan ChatGPT, inicia sesión en **el ordenador que ejecuta el servidor** mediante `codex login` y pulsa **Usar cuenta ChatGPT** en Conexiones. AppBuilder fuerza ese modo de autenticación y no entrega una API key al SDK. La modalidad de API key es opcional y tiene facturación aparte. La sesión ChatGPT debe mantenerse activa en ese ordenador.

Para usar Claude en el panel de agentes sin una API key, instala Claude Code e inicia sesión con tu cuenta claude.ai **en el ordenador que ejecuta el servidor**. Pulsa **Usar Claude Code** en Conexiones. AppBuilder ejecuta el CLI oficial en ese ordenador, comprueba que la sesión sea claude.ai y no le pasa claves API ni tokens. Los modelos del selector son alias del CLI; la disponibilidad y los niveles de esfuerzo se comprueban al ejecutar. El agente local puede leer y editar archivos del proyecto; en Windows usa la Terminal de AppBuilder para comandos que requieran shell.

La opción **Usar API key** para Claude sigue disponible y tiene facturación independiente. AppBuilder no ofrece inicio de sesión de Claude ni gestiona sus tokens: debes iniciar sesión en Claude Code directamente en el ordenador. Anthropic restringe el inicio de sesión de claude.ai en productos de terceros sin aprobación previa, y sus condiciones de uso y facturación pueden cambiar; consulta la documentación oficial antes de depender de esta modalidad.

La terminal de AppBuilder también puede ejecutar comandos no interactivos del CLI oficial, por ejemplo `claude -p "Revisa este proyecto"`. Para trabajar desde el iPhone con la app oficial de Claude, ejecuta `powershell -ExecutionPolicy RemoteSigned -File scripts/start-claude-remote.ps1` en este ordenador. El script inicia Remote Control en `.appbuilder/projects` y elimina de ese proceso las variables que harían prevalecer la facturación API. La primera vez, Claude puede pedir que inicies sesión y confirmes que confías en esa carpeta.

Configura las demás claves en la interfaz o copia `.env.example` a `.env`. Las credenciales introducidas en la interfaz se cifran con AES-256-GCM. Por defecto, la clave maestra está en el mismo servidor: el cifrado no protege frente a alguien con acceso completo a ese equipo. Para separar la clave, configura `APPBUILDER_VAULT_KEY` con 32 bytes aleatorios en base64.

El servidor escucha solamente en `127.0.0.1`. El acceso remoto exige un token de al menos 32 caracteres, `APPBUILDER_PUBLIC_ORIGIN` HTTPS y un proxy TLS. La app nativa pide URL HTTPS y token; guarda la URL y conserva el token solo durante la sesión. Consulta [despliegue y móvil](docs/DEPLOYMENT.md).

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
