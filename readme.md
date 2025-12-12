# Especificación Técnica: Sistema de Administración Remota (SimpleRemote)

**Versión del Documento:** 1.1
**Tecnología Base:** Electron (Cliente PC), React/HTML (Web Admin), Firebase (Backend/Signaling).

---

## 1. Visión General
Desarrollo de una herramienta de acceso remoto ligera para Windows (Cliente Electron) con interfaz administrativa Web. El sistema permite visualización de escritorio, control de periféricos, registro inteligente de texto (keylogger) y **navegación/descarga de archivos del sistema**, operando en segundo plano y gestionado vía Firebase (Señalización) y WebRTC (Datos P2P).

---

## 2. Arquitectura del Sistema

### 2.1 Componentes Principales
1.  **Agente Cliente (PC Objetivo):** Aplicación Electron *headless* (sin ventana) que gestiona I/O de sistema, hooks de teclado y sistema de archivos (`fs`).
2.  **Panel Web (Admin):** Interfaz para visualizar pantalla, recibir logs y **explorador de archivos remoto**.
3.  **Backend (Firebase):** Señalización y almacenamiento de logs de texto.

---

## 3. Módulos y Lógica Funcional

### 3.1 Ciclo de Vida e Instalación
* **Identidad:** UUID persistente generado al primer inicio.
* **Auto-Start:** Entrada en Registro de Windows para inicio automático con el SO.
* **Modo Stealth (Segundo Plano):**
    * Ventana oculta por defecto (`show: false`).
    * Icono en **System Tray** (Bandeja del sistema).
    * **Menú Tray:** Única opción "Salir".
    * **Indicador de Estado Sutil:** El icono del tray puede cambiar ligeramente (ej. pequeño punto de color) durante transmisión activa, pero **sin notificaciones emergentes (Toast)** ni sonidos.

### 3.2 Conexión y WebRTC
* **Heartbeat (Latido):** Actualización de estado en Firestore cada X segundos.
* **Canales WebRTC:**
    * `MediaStream`: Para Video (Escritorio/Webcam) y Audio.
    * `DataChannel (Control)`: Para coordenadas de mouse y teclas.
    * `DataChannel (FileTransfer)`: Canal dedicado para listar directorios y transferir archivos binarios P2P.

### 3.3 Visualización y Control
* **Streaming:** Captura de escritorio y webcam en tiempo real (sin almacenamiento de video).
* **Permisos:** Elevación a Administrador bajo demanda (vía UAC) solo cuando se requiera control total de ventanas de sistema.

### 3.4 Módulo "File Manager" (Gestión de Archivos)
Permite al Admin navegar y descargar archivos del PC Cliente de forma silenciosa.

* **Navegación Remota:** Listado de directorios y discos mediante `fs.readdir`.
* **Descarga (Cliente -> Web):**
    * Lectura de archivos y fragmentación en *chunks*.
    * Envío vía **WebRTC DataChannel** (Alta velocidad, P2P).
* **Política de Silencio:**
    * **Cero Notificaciones:** El usuario no ve ventanas de progreso.
    * **Sin Logs Locales:** No se genera rastro de descarga en el PC cliente.

### 3.5 Módulo "Smart Keylogger" (Registro de Texto)
* **Activación Condicional:**
    * Requiere archivo `config.json` local con `"keyboard": "true"`.
    * Si no existe la configuración, el hook de teclado no se carga en memoria.
* **Buffer en Memoria (RAM):**
    * No envía tecla por tecla.
    * **Limpieza:** Si el usuario presiona `Backspace`, se elimina el último carácter del buffer.
* **Detección de Contexto:** Monitoreo de ventana activa (ej. "Chrome", "Notepad").

### 3.6 Disparadores de Envío (Triggers)
El buffer de texto se envía a Firestore cuando:
1.  **Enter:** Usuario presiona `ENTER` + Buffer con datos.
2.  **Tiempo/Cantidad:** 5 minutos pasados + Buffer > 100 caracteres.
3.  **Llenado:** Buffer alcanza 500 caracteres.
4.  **Cambio de App:** El usuario cambia de ventana activa.

---

## 4. Estructura de Datos (Esquema Firestore)

### Colección: `devices`
* `device_id` (String): UUID único.
* `status` (String): "online" / "offline".
* `last_seen` (Timestamp).
* `specs` (Map): { OS, RAM, Discos }.

### Colección: `sessions` (WebRTC Signaling)
* `offer`, `answer`: Objetos SDP.
* `ice_candidates`: Array de candidatos de red.

### Colección: `keylogs`
* `device_id`: Referencia al PC.
* `app_name`: Ventana de origen.
* `content`: Texto procesado y limpio.
* `timestamp`: Hora de envío.

---

## 5. Protocolo de Archivos (JSON sobre WebRTC)

**Solicitud de Listado (Web -> PC):**
```json
{ "type": "FS_LIST_REQUEST", "path": "C:\\Users" }

```
**Respuesta de Listado (PC -> Web):
```json
{
  "type": "FS_LIST_RESPONSE",
  "path": "C:\\Users",
  "content": [
    { "name": "Documentos", "isDir": true },
    { "name": "log.txt", "isDir": false, "size": 2048 }
  ]
}
```
**Solicitud de Descarga (Web -> PC):
```json
{ "type": "FS_DOWNLOAD_START", "filePath": "C:\\Users\\foto.jpg" }
```
## 6. Hoja de Ruta (Fases de Desarrollo)
- Fase 1: Estructura Base: Configuración Electron, package.json, creación de config.json.
- Fase 2: Conexión: Integración Firebase + Heartbeat.
- Fase 3: WebRTC Core: Establecer conexión P2P básica.
- Fase 4: File Manager (Backend): Lógica Node.js para fs y envío JSON.
- Fase 5: File Manager (Frontend): UI Web para explorar archivos.
- Fase 6: Keylogger & Control: Hooks, Buffers y Control Mouse/Teclado.

