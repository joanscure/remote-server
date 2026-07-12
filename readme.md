# remote-server

Herramienta personal de escritorio remoto (estilo AnyDesk/TeamViewer) para controlar las laptops de casa desde el navegador, sin depender de permisos de administrador/UAC. Screen share, control de mouse/teclado, transferencia de archivos, clipboard y consola remota, sobre WebRTC con señalización vía Firestore.

## Arquitectura

```
┌─────────────┐        Firestore         ┌──────────────────┐
│   web/      │  (presencia + señaliza-  │   client/         │
│  React+Vite │  ción: offer/answer/     │  Electron agent   │
│  (control)  │  ICE candidates)         │  (dispositivo     │
│             │◄────────────────────────►│  controlado)      │
└──────┬──────┘                          └─────────┬─────────┘
       │                                            │
       └────────────── WebRTC (STUN/TURN) ──────────┘
              screen · audio · input · data channel
```

- **`client/`** — Agente Electron que corre en cada laptop a controlar. Se instala con auto-inicio al login, corre oculto en bandeja del sistema (sin ventana visible, "modo stealth"), y expone la pantalla/input/filesystem de esa máquina vía WebRTC cuando recibe una oferta de conexión.
- **`web/`** — Frontend (React + Vite) desde el que te conectas a un dispositivo: lista de dispositivos, video del escritorio remoto, gestor de archivos, consola, etc.
- **Firestore** — No transmite audio/video/input; solo se usa para presencia (heartbeat) y señalización WebRTC (intercambio de offer/answer/ICE candidates).

## `client/` (agente Electron)

| Archivo | Rol |
|---|---|
| `index.js` | Proceso principal Electron: crea la ventana oculta, el ícono de bandeja, maneja `desktopCapturer`, auto-updater (`electron-updater`), auto-inicio al login, y `powerMonitor` para detectar suspensión/reanudación del SO. |
| `renderer.js` | Proceso renderer: heartbeat periódico a Firestore (`devices/{deviceId}`, cada 5 min) y listener de `sessions` (Firestore `onSnapshot`) para recibir ofertas de conexión entrantes. |
| `src/services/webRTCService.js` | Maneja el ciclo de vida del `RTCPeerConnection`: crea la respuesta (answer) a una offer, comparte pantalla/micrófono, bitrate adaptativo según RTT/pérdida de paquetes, y el data channel con el protocolo de comandos remotos (`FS_LIST_REQUEST`, `FS_DOWNLOAD_START`, `CLIPBOARD_*`, `CONSOLE_COMMAND`, `SWITCH_SOURCE`, `GET_METRICS`, etc.). Todo lo que no matchea un comando conocido se delega a `inputService` (control de mouse/teclado). |
| `src/services/inputService.js` | Traduce mensajes del data channel a eventos de input reales en el SO (mouse/teclado), vía `@mintplex-labs/nut-js` / `uiohook-napi`. |
| `src/services/systemService.js` | Operaciones de sistema del lado agente: listar archivos/discos, subir/bajar archivos, clipboard, comandos de consola, métricas. |
| `src/config/configManager.js` | Genera y persiste un `deviceId` (UUID) y nombre de dispositivo en `%APPDATA%/.info-pc/config.json`, fuera del propio directorio de instalación. |
| `firebaseConfig.js` | Config e inicialización del cliente Firestore (SDK modular v9+, `firebase/firestore`). |

Empaquetado con `electron-builder` (target NSIS para Windows, `appId: com.jdev-control.server`), con auto-actualización apuntando a releases de GitHub (`joanscure/remote-server`).

## `web/` (panel de control)

| Archivo | Rol |
|---|---|
| `src/hooks/useDevices.js` | Suscripción a la colección `devices` de Firestore para listar dispositivos y su estado (online/offline calculado en frontend por antigüedad de `last_seen`). |
| `src/hooks/useWebRTC.js` | Crea el `RTCPeerConnection` del lado navegador, el documento `sessions` en Firestore (offer + ICE candidates), y gestiona el estado de la conexión. |
| `src/components/DeviceList.jsx` | Listado de dispositivos con botón de conectar. |
| `src/components/VideoWorkspace.jsx`, `Monitor.jsx`, `Sidebar.jsx`, `Header.jsx` | UI de la sesión remota activa. |
| `src/components/FileManager.jsx` | Explorador de archivos remoto sobre el data channel. |

## Modelo de datos en Firestore

- **`devices/{deviceId}`**: `device_id`, `status` (el agente *siempre* escribe `"online"` — nunca escribe `"offline"`; el estado offline que ves en el panel es puramente calculado en el frontend por antigüedad de `last_seen`), `last_seen` (`serverTimestamp()`), `name`, `specs` (`platform`, `arch`).
- **`sessions/{sessionId}`**: `deviceId`, `offer`, `answer`, `ice_candidates_caller`, `ice_candidates_callee`. El agente escucha solo documentos nuevos (`change.type === "added"`) filtrados por su propio `deviceId`.


