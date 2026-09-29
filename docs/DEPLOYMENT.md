# Ejecutar e instalar AppBuilder

AppBuilder incluye una interfaz React para móvil y escritorio, una PWA y un cliente nativo Capacitor. El servidor Node.js ejecuta los agentes, los comandos y los proyectos. **El APK y la app iOS no contienen ese servidor**: necesitan conectarse a una instancia accesible por HTTPS.

Esta versión es un entorno de **un solo usuario**. La terminal ejecuta comandos con los permisos de la cuenta que inicia el servidor. No es una plataforma pública con aislamiento entre clientes.

## Desarrollo local

Requisitos: Node.js 22.12 o posterior, npm y Git. Los SDK de los agentes están entre las dependencias del proyecto; sus cuentas y claves se configuran por separado.

```powershell
npm ci
Copy-Item .env.example .env
npm run doctor
npm run dev
```

Abre la dirección que muestra Vite. El servidor utiliza `127.0.0.1:4310` por defecto. El archivo `.env` y los datos de trabajo no deben subirse a Git.

Para servir la interfaz compilada desde el mismo servidor:

```powershell
npm run check
npm test
npm run build
npm start
```

## Acceder desde un teléfono

Instala el servidor en tu ordenador o en una máquina que controles. Configura un proxy HTTPS delante y una autenticación de acceso. Mantén Node.js en la interfaz de loopback si el proxy está en esa misma máquina; si cambias `HOST` para aceptar conexiones remotas, define `APPBUILDER_ACCESS_TOKEN`.

Variables de servidor:

| Variable                   | Uso                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `HOST`                     | Dirección de escucha; por defecto `127.0.0.1`.                                                 |
| `PORT`                     | Puerto del servidor; por defecto `4310`.                                                       |
| `APPBUILDER_ACCESS_TOKEN`  | Secreto largo y aleatorio para acceder al servidor. Obligatorio al escuchar fuera de loopback. |
| `APPBUILDER_PUBLIC_ORIGIN` | Origen público HTTPS, por ejemplo `https://studio.example.com`.                                |
| `APPBUILDER_DATA_DIR`      | Ubicación persistente de datos y proyectos.                                                    |
| `OPENAI_API_KEY`           | Acceso API a OpenAI cuando corresponda al modo de autenticación elegido.                       |
| `ANTHROPIC_API_KEY`        | Acceso API a Claude.                                                                           |
| `CODEMAGIC_API_TOKEN`      | Acceso a tu cuenta Codemagic.                                                                  |

Las claves de proveedores se configuran en el servidor o en Conexiones. No las pongas en variables `VITE_*`, el repositorio, capturas ni URLs. Toda variable `VITE_*` acaba siendo pública dentro de la interfaz compilada. La URL del servidor es pública; su token de acceso se introduce por separado.

Antes de exponer la terminal a Internet, ejecuta el servidor o sus procesos de trabajo en un contenedor o una máquina dedicada con permisos limitados. El acceso remoto requiere HTTPS, autenticación y un entorno aislado; un token por sí solo no convierte este servidor en un servicio para múltiples usuarios. Haz copias de seguridad del directorio de datos y protege los archivos de credenciales con permisos del sistema operativo.

## Instalar como PWA

Con el servidor servido por HTTPS, abre AppBuilder en el navegador del teléfono y usa **Instalar aplicación** o **Añadir a pantalla de inicio**, según el navegador. En Safari de iPhone se encuentra en Compartir.

El service worker solo guarda la pantalla informativa sin conexión y el icono. No guarda las respuestas de la API, archivos de proyectos, credenciales ni la aplicación completa. Editar, ejecutar y usar agentes requiere conexión con el servidor. En desarrollo local el service worker puede no estar registrado.

## Android e iOS con Capacitor

La configuración usa `dev.appbuilder.studio` y empaqueta el contenido de `dist`. Al arrancar, el cliente utiliza la URL HTTPS configurada o muestra la configuración de conexión. La interfaz y el servidor pueden actualizarse por separado; vuelve a compilar y sincronizar para llevar cambios de interfaz a la app nativa.

Para incluir una URL pública predeterminada al compilar, usa `VITE_APPBUILDER_SERVER_URL`. En Codemagic el parámetro `server_url` configura esta variable y `APPBUILDER_SERVER_URL`, que valida el diagnóstico. Nunca incluyas el token de acceso en estas variables.

```powershell
$env:VITE_APPBUILDER_SERVER_URL = 'https://studio.example.com'
npm run build
```

Si aún no existen los proyectos nativos, créalos una vez y después guárdalos en Git:

```powershell
npx cap add android
npx cap add ios
npx cap sync
```

Android requiere Android Studio, JDK 21 y Android SDK. Comprueba el entorno y abre el proyecto:

```powershell
npm run doctor -- --android
npm run mobile:sync
npm run mobile:android
```

Para un APK de pruebas desde PowerShell, después de sincronizar:

```powershell
.\android\gradlew.bat -p android assembleDebug
```

El APK aparece en `android/app/build/outputs/apk/debug/`. Usa el APK solo para pruebas; Google Play requiere una build de distribución firmada y su configuración correspondiente.

iOS requiere macOS y Xcode para compilar localmente. En un Mac:

```sh
npm run doctor -- --ios
npm run mobile:sync
npm run mobile:ios
```

En Windows puedes mantener el código y usar Codemagic para la compilación de iOS. Un artefacto de simulador no se instala en un iPhone físico.

## Compilar con Codemagic

Conecta el repositorio a tu cuenta e importa el archivo `codemagic.yaml` de la raíz. Están definidos estos workflows manuales:

| Workflow        | Resultado                                                                  |
| --------------- | -------------------------------------------------------------------------- |
| `web-check`     | Instalación reproducible, comprobación de tipos, tests y `dist`.           |
| `android-debug` | Mismas verificaciones, sincronización Capacitor y APK debug.               |
| `ios-simulator` | Mismas verificaciones y app iOS de simulador sin firma, comprimida en ZIP. |

Los workflows nativos aceptan `server_url` como origen HTTPS público. Déjalo vacío para configurar la conexión al abrir la app. Los certificados, claves de firma y credenciales de publicación deben permanecer en la gestión de secretos de Codemagic; no se incluyen en este repositorio.

La configuración no publica en las tiendas. Para distribuir debes añadir firma Android o perfiles/certificados Apple, dar de alta la aplicación y configurar los canales de prueba o publicación de tu cuenta. Las APIs de App Store Connect y Google Play no eliminan esos requisitos. La aceptación de la app por las tiendas sigue dependiendo de su revisión.

## Verificación continua

GitHub Actions ejecuta `npm ci`, `npm run check`, `npm test`, `npm run build` y los recorridos Playwright en Chromium para móvil y escritorio. Los workflows nativos incluyen las comprobaciones de tipos, servidor y compilación web. El diagnóstico opcional `node scripts/check-env.mjs --require-server` falla si falta una URL HTTPS predeterminada; los workflows de pruebas permiten omitirla.

Referencias: [configuración de Capacitor](https://capacitorjs.com/docs/config), [configuración YAML de Codemagic](https://docs.codemagic.io/yaml-basic-configuration/yaml-getting-started/) y [builds para simulador iOS](https://docs.codemagic.io/yaml-code-signing/ios-simulator-builds/).
