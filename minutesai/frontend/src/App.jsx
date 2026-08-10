import { useState, useRef, useEffect } from "react";

const BACKEND_URL = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/ws/transcribe";

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState([]); // [{speaker, text}]
  const [interimSegments, setInterimSegments] = useState([]); // [{speaker, text}]
  const [speakerNames, setSpeakerNames] = useState({}); // {1: "Alice"}
  const [minutes, setMinutes] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [meetingHistory, setMeetingHistory] = useState(
    JSON.parse(localStorage.getItem("minutesai_history") || "[]")
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [currentSpeakerNum, setCurrentSpeakerNum] = useState(1);
  const [hasVideo, setHasVideo] = useState(false);

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const transcriptEndRef = useRef(null);
  const videoRef = useRef(null);
  const captureIntervalRef = useRef(null);
  const currentSpeakerNumRef = useRef(1);
  const speakerNamesRef = useRef({});
  const pendingNameRef = useRef({}); // {speakerNum: nameSeenOnce} — awaiting confirmation

  useEffect(() => {
    speakerNamesRef.current = speakerNames;
  }, [speakerNames]);

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript, interimSegments]);

  const displayName = (speakerNum) => speakerNames[speakerNum] || `Speaker ${speakerNum}`;

  // Scans a canvas for Zoom's active-speaker highlight border and returns
  // its bounding box, or null if no one is currently highlighted.
  //
  // Uses a coarse grid + union-find to CLUSTER matching pixels into
  // connected groups, then keeps only the LARGEST cluster. This matters:
  // a plain global min/max bounding box merges ANY green pixels found
  // anywhere in the frame into one box — even two unrelated tiles far
  // apart — which was pulling in two people's name labels at once.
  const findGreenBoxRegion = (canvas) => {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const cell = 6; // grid cell size in px — coarser than pixel-level for speed
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const grid = new Uint8Array(cols * rows); // 1 = green cell

    let bestScore = -999, bestR = 0, bestG = 0, bestB = 0;

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const px = Math.min(width - 1, gx * cell + Math.floor(cell / 2));
        const py = Math.min(height - 1, gy * cell + Math.floor(cell / 2));
        const i = (py * width + px) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const score = (g - r) + (g - b);
        if (score > bestScore) { bestScore = score; bestR = r; bestG = g; bestB = b; }
        if (g > 140 && (g - r) > 35 && (g - b) > 35) {
          grid[gy * cols + gx] = 1;
        }
      }
    }

    // Union-find over the grid to cluster adjacent green cells.
    const parent = new Int32Array(cols * rows).map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (!grid[gy * cols + gx]) continue;
        if (gx + 1 < cols && grid[gy * cols + gx + 1]) union(gy * cols + gx, gy * cols + gx + 1);
        if (gy + 1 < rows && grid[(gy + 1) * cols + gx]) union(gy * cols + gx, (gy + 1) * cols + gx);
      }
    }

    const clusterCells = new Map(); // root -> [{gx,gy}]
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (!grid[gy * cols + gx]) continue;
        const root = find(gy * cols + gx);
        if (!clusterCells.has(root)) clusterCells.set(root, []);
        clusterCells.get(root).push({ gx, gy });
      }
    }

    if (clusterCells.size === 0) {
      console.log(`No green highlight box detected — greenest pixel: rgb(${bestR},${bestG},${bestB})`);
      return null;
    }

    // Keep only the largest cluster — that's the one real highlight border.
    let largest = null;
    for (const cells of clusterCells.values()) {
      if (!largest || cells.length > largest.length) largest = cells;
    }
    if (largest.length < 8) return null; // too small to be a real border

    let minGX = cols, maxGX = 0, minGY = rows, maxGY = 0;
    for (const { gx, gy } of largest) {
      if (gx < minGX) minGX = gx;
      if (gx > maxGX) maxGX = gx;
      if (gy < minGY) minGY = gy;
      if (gy > maxGY) maxGY = gy;
    }
    const x = minGX * cell, y = minGY * cell;
    const boxW = (maxGX - minGX + 1) * cell;
    const boxH = (maxGY - minGY + 1) * cell;
    if (boxW < 20 || boxH < 20) return null;
    if (boxW > width * 0.5 || boxH > height * 0.5) return null; // single tile sanity cap

    return { x, y, width: Math.min(boxW, width - x), height: Math.min(boxH, height - y) };
  };

  const captureFrameAndDetectName = async (speakerNum = 1) => {
    if (!videoRef.current || !videoRef.current.videoWidth) {
      console.log("OCR capture skipped: no video stream (audio-only share/mic in use?)");
      return;
    }
    try {
      const full = document.createElement("canvas");
      full.width = videoRef.current.videoWidth;
      full.height = videoRef.current.videoHeight;
      full.getContext("2d").drawImage(videoRef.current, 0, 0, full.width, full.height);

      const region = findGreenBoxRegion(full);
      if (!region) {
        return; // no one is highlighted right now, or match was rejected — logged inside findGreenBoxRegion
      }

      // Crop to the tile with a small margin so the name label at the
      // bottom of the tile isn't clipped by a tight bounding box.
      const pad = 16;
      const cx = Math.max(0, region.x - pad);
      const cy = Math.max(0, region.y - pad);
      const cw = Math.min(full.width - cx, region.width + pad * 2);
      const ch = Math.min(full.height - cy, region.height + pad * 2);

      const crop = document.createElement("canvas");
      crop.width = cw;
      crop.height = ch;
      crop.getContext("2d").drawImage(full, cx, cy, cw, ch, 0, 0, cw, ch);
      const frameData = crop.toDataURL("image/png");

      const response = await fetch(`${BACKEND_URL}/api/detect-speaker-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: frameData, speaker_num: speakerNum }),
      });
      const data = await response.json();
      console.log("OCR result:", data);
      if (data.name) {
        const pending = pendingNameRef.current[speakerNum];
        if (pending === data.name) {
          // Same name seen twice in a row for this speaker — trust it now.
          // Locking on a SINGLE read is risky: the video frame can lag the
          // audio Deepgram used to decide "speaker changed," so one bad
          // frame could otherwise glue the wrong name to this speaker number
          // permanently. Requiring a repeat catches that mistimed-frame case.
          setSpeakerNames((prev) => ({ ...prev, [speakerNum]: data.name }));
          delete pendingNameRef.current[speakerNum];
        } else {
          pendingNameRef.current[speakerNum] = data.name;
        }
      }
    } catch (err) {
      console.error("OCR capture failed", err);
    }
  };

  const openSocket = () => {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(WS_URL);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { setIsConnected(true); resolve(socket); };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "transcript") {
            const segments = data.segments || [];
            if (segments.length === 0) return;

            const lastSeg = segments[segments.length - 1];
            const speakerChanged = lastSeg.speaker !== currentSpeakerNumRef.current;
            setCurrentSpeakerNum(lastSeg.speaker);
            currentSpeakerNumRef.current = lastSeg.speaker;
            // Speaker just changed — grab a frame shortly after instead of
            // waiting for the next scheduled poll. A short delay is added
            // because the video frame can lag behind the audio Deepgram
            // used to detect the speaker change; capturing instantly risks
            // grabbing a frame where the green box hasn't moved yet.
            if (speakerChanged && !speakerNamesRef.current[lastSeg.speaker]) {
              const capturingSpeaker = lastSeg.speaker;
              setTimeout(() => {
                if (currentSpeakerNumRef.current === capturingSpeaker) {
                  captureFrameAndDetectName(capturingSpeaker);
                }
              }, 900);
            }

            if (data.is_final) {
              setTranscript((prev) => {
                const merged = [...prev];
                segments.forEach((seg) => {
                  // Freeze whatever name was known for this speaker at the
                  // exact moment this line was spoken — later name updates
                  // (from OCR catching up) will NOT rewrite this line.
                  const resolvedName = speakerNamesRef.current[seg.speaker] || `Speaker ${seg.speaker}`;
                  const last = merged[merged.length - 1];
                  if (last && last.speaker === seg.speaker && last.name === resolvedName) {
                    merged[merged.length - 1] = {
                      ...last,
                      text: last.text + " " + seg.text,
                    };
                  } else {
                    merged.push({ ...seg, name: resolvedName });
                  }
                });
                return merged;
              });
              setInterimSegments([]);
            } else {
              // Interim (not-yet-final) lines still show live so the label
              // can catch up to a name detected mid-sentence.
              setInterimSegments(
                segments.map((seg) => ({
                  ...seg,
                  name: speakerNamesRef.current[seg.speaker] || `Speaker ${seg.speaker}`,
                }))
              );
            }
          }
        } catch (e) { console.error("Error:", e); }
      };
      socket.onerror = (err) => { setErrorMsg("Connection error."); reject(err); };
      socket.onclose = () => { setIsConnected(false); };
      socketRef.current = socket;
    });
  };

  const startRecording = async () => {
    setErrorMsg("");
    setInterimSegments([]);
    setSpeakerNames({});
    setCurrentSpeakerNum(1);
    currentSpeakerNumRef.current = 1;
    try {
      const socket = await openSocket();
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 16000 },
          video: true
        });
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) throw new Error("No audio");
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000 }
        });
      }
      streamRef.current = stream;

      if (stream.getVideoTracks().length > 0 && videoRef.current) {
        setHasVideo(true);
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      } else {
        setHasVideo(false);
      }

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processorCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              const float32 = input[0];
              const int16 = new Int16Array(float32.length);
              for (let i = 0; i < float32.length; i++) {
                int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
              }
              this.port.postMessage(int16.buffer, [int16.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `;
      const blob = new Blob([processorCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await audioContext.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
      workletNodeRef.current = workletNode;
      workletNode.port.onmessage = (e) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(e.data);
      };
      source.connect(workletNode);
      workletNode.connect(audioContext.destination);

      if (stream.getVideoTracks().length > 0) {
        captureIntervalRef.current = setInterval(() => {
          captureFrameAndDetectName(currentSpeakerNumRef.current || 1);
        }, 2500);
      }

      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((prev) => prev + 1), 1000);
    } catch (err) {
      setErrorMsg(err.name === "NotAllowedError"
        ? "Microphone access denied."
        : "Failed to start recording. Please try again."
      );
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    clearInterval(timerRef.current);
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    if (workletNodeRef.current) workletNodeRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setHasVideo(false);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (socketRef.current) socketRef.current.close();
  };

  const buildFullTranscriptText = () => {
    const all = [...transcript, ...interimSegments];
    return all.map((seg) => `${speakerNames[seg.speaker] || seg.name || `Speaker ${seg.speaker}`}: ${seg.text}`).join("\n");
  };

  const generateMinutes = async () => {
    const fullTranscript = buildFullTranscriptText();
    if (!fullTranscript.trim()) {
      setErrorMsg("No transcript available.");
      return;
    }
    setIsGenerating(true);
    setErrorMsg("");
    try {
      const response = await fetch(`${BACKEND_URL}/api/generate-minutes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: fullTranscript.trim() }),
      });
      const data = await response.json();
      setMinutes(data);
      const newMeeting = {
        id: Date.now(),
        date: new Date().toLocaleDateString(),
        title: data.meeting_title || "Untitled",
        type: data.type || "meeting",
        minutes: data
      };
      const updated = [newMeeting, ...meetingHistory].slice(0, 20);
      setMeetingHistory(updated);
      localStorage.setItem("minutesai_history", JSON.stringify(updated));
    } catch (err) {
      setErrorMsg("Failed to generate minutes. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  };

  const exportPDF = async () => {
    if (!minutes) return;
    setIsExporting(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/export-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minutes }),
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "meeting-minutes.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg("Failed to export PDF.");
    } finally {
      setIsExporting(false);
    }
  };

  const formatTime = (seconds) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = (seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const filteredHistory = meetingHistory.filter(m =>
    m.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const typeLabel = (type) => {
    if (type === "lecture") return "📚 Lecture";
    if (type === "webinar") return "🎥 Webinar";
    return "💼 Meeting";
  };

  const typeColor = (type) => {
    if (type === "lecture") return "#00D4AA";
    if (type === "webinar") return "#FFD700";
    return "#6C63FF";
  };

  const renameSpeaker = (speakerNum) => {
    const current = displayName(speakerNum);
    const next = window.prompt(`Rename ${current} to:`, current.startsWith("Speaker") ? "" : current);
    if (next && next.trim()) {
      setSpeakerNames((prev) => ({ ...prev, [speakerNum]: next.trim() }));
    }
  };

  return (
    <div style={{ minHeight:"100vh", background:"#0F0F1A", color:"#FFFFFF", fontFamily:"system-ui, sans-serif", padding:"20px" }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"30px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
          <div style={{ width:"40px", height:"40px", background:"#6C63FF", borderRadius:"10px", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"20px" }}>🎙️</div>
          <div>
            <div style={{ fontSize:"22px", fontWeight:"bold" }}>MinutesAI</div>
            <div style={{ fontSize:"12px", color:"#B0B0C0" }}>Real-time Meeting Assistant</div>
          </div>
        </div>
        <div style={{ padding:"6px 12px", borderRadius:"20px", background: isConnected ? "#00D4AA22" : "#FF475722", color: isConnected ? "#00D4AA" : "#FF4757", fontSize:"13px" }}>
          {isConnected ? "● Live" : "● Disconnected"}
        </div>
      </div>

      {errorMsg && (
        <div style={{ background:"#FF475722", border:"1px solid #FF4757", borderRadius:"8px", padding:"12px", marginBottom:"20px", color:"#FF4757" }}>
          {errorMsg}
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"20px" }}>

        {/* Left Panel */}
        <div>
          {/* Recording */}
          <div style={{ background:"#1A1A2E", borderRadius:"12px", padding:"24px", marginBottom:"20px", textAlign:"center" }}>
            <video ref={videoRef} muted style={{ width:"100%", borderRadius:"8px", marginBottom: hasVideo ? "16px" : 0, display: hasVideo ? "block" : "none" }} />
            <div style={{ fontSize:"48px", marginBottom:"12px" }}>{isRecording ? "🔴" : "🎙️"}</div>
            {isRecording ? (
              <div>
                <div style={{ fontSize:"32px", fontWeight:"bold", color:"#FF4757", marginBottom:"8px" }}>{formatTime(recordingTime)}</div>
                <div style={{ color:"#B0B0C0", marginBottom:"20px" }}>Streaming to Deepgram...</div>
              </div>
            ) : (
              <div style={{ color:"#B0B0C0", marginBottom:"20px" }}>Click to start recording</div>
            )}
            <button onClick={isRecording ? stopRecording : startRecording}
              style={{ width:"100%", padding:"14px", borderRadius:"8px", border:"none", cursor:"pointer", fontSize:"16px", fontWeight:"bold", background: isRecording ? "#FF4757" : "#6C63FF", color:"white" }}>
              {isRecording ? "⏹ Stop Recording" : "▶ Start Recording"}
            </button>
          </div>

          {/* Transcript */}
          <div style={{ background:"#1A1A2E", borderRadius:"12px", padding:"20px", marginBottom:"20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"12px" }}>
              <span style={{ fontWeight:"bold" }}>📝 Live Transcript</span>
              <button onClick={() => { setTranscript([]); setInterimSegments([]); }}
                style={{ background:"transparent", border:"1px solid #2A2A3E", color:"#B0B0C0", padding:"4px 10px", borderRadius:"6px", cursor:"pointer" }}>
                Clear
              </button>
            </div>
            <div style={{ minHeight:"200px", maxHeight:"300px", overflowY:"auto", lineHeight:"1.6", fontSize:"14px" }}>
              {transcript.length === 0 && interimSegments.length === 0 ? (
                <span style={{ color:"#B0B0C0" }}>Your live transcript will appear here...</span>
              ) : (
                <>
                  {transcript.map((seg, i) => (
                    <div key={i} style={{ marginBottom:"4px" }}>
                      <strong
                        onClick={() => renameSpeaker(seg.speaker)}
                        style={{ cursor:"pointer", color:"#6C63FF" }}
                        title="Click to rename"
                      >
                        {speakerNames[seg.speaker] || seg.name}:
                      </strong>{" "}
                      {seg.text}
                    </div>
                  ))}
                  {interimSegments.map((seg, i) => (
                    <div key={"int" + i} style={{ marginBottom:"4px", opacity:0.7 }}>
                      <strong style={{ color:"#6C63FF" }}>{speakerNames[seg.speaker] || seg.name}:</strong> {seg.text}
                    </div>
                  ))}
                </>
              )}
              <div ref={transcriptEndRef} />
            </div>
            <button onClick={generateMinutes}
              disabled={isGenerating || (transcript.length === 0 && interimSegments.length === 0)}
              style={{ width:"100%", marginTop:"16px", padding:"12px", borderRadius:"8px", border:"none", cursor:"pointer", fontSize:"15px", fontWeight:"bold", background: isGenerating ? "#2A2A3E" : "#6C63FF", color:"white" }}>
              {isGenerating ? "⏳ Generating..." : "✨ Generate Minutes"}
            </button>
          </div>

          {/* History */}
          <div style={{ background:"#1A1A2E", borderRadius:"12px", padding:"20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"12px" }}>
              <span style={{ fontWeight:"bold" }}>📚 Meeting History</span>
              <input placeholder="🔍 Search..." value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ background:"#0F0F1A", border:"1px solid #2A2A3E", color:"white", padding:"6px 12px", borderRadius:"6px", fontSize:"13px", width:"140px" }}/>
            </div>
            {filteredHistory.length === 0 ? (
              <div style={{ color:"#B0B0C0", fontSize:"13px" }}>
                {searchQuery ? "No results found." : "No meetings saved yet."}
              </div>
            ) : (
              filteredHistory.map(m => (
                <div key={m.id} onClick={() => setMinutes(m.minutes)}
                  style={{ background:"#0F0F1A", padding:"12px", borderRadius:"8px", marginBottom:"8px", cursor:"pointer", border:"1px solid #2A2A3E" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div style={{ fontWeight:"bold", fontSize:"14px" }}>{m.title}</div>
                    <span style={{ fontSize:"11px", padding:"2px 8px", borderRadius:"10px", background: typeColor(m.type)+"22", color: typeColor(m.type) }}>
                      {typeLabel(m.type)}
                    </span>
                  </div>
                  <div style={{ color:"#B0B0C0", fontSize:"12px", marginTop:"4px" }}>📅 {m.date}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div style={{ background:"#1A1A2E", borderRadius:"12px", padding:"24px", overflowY:"auto", maxHeight:"90vh" }}>
          {!minutes ? (
            <div style={{ textAlign:"center", color:"#B0B0C0", paddingTop:"60px" }}>
              <div style={{ fontSize:"48px", marginBottom:"16px" }}>✨</div>
              <div style={{ fontSize:"18px", marginBottom:"8px" }}>No Minutes Yet</div>
              <div style={{ fontSize:"13px" }}>Record a meeting then click Generate</div>
            </div>
          ) : (
            <div>
              {/* Title + Type + Export */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"20px" }}>
                <div>
                  <h2 style={{ margin:"0 0 6px 0", color:"#6C63FF" }}>{minutes.meeting_title}</h2>
                  <span style={{ fontSize:"12px", padding:"3px 10px", borderRadius:"20px", background: typeColor(minutes.type)+"22", color: typeColor(minutes.type) }}>
                    {typeLabel(minutes.type)}
                  </span>
                </div>
                <button onClick={exportPDF} disabled={isExporting}
                  style={{ padding:"8px 16px", background:"#00D4AA", color:"white", border:"none", borderRadius:"8px", cursor:"pointer", fontWeight:"bold" }}>
                  {isExporting ? "Exporting..." : "📄 Export PDF"}
                </button>
              </div>

              {/* Summary - all types */}
              <div style={{ background:"#6C63FF22", borderLeft:"3px solid #6C63FF", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                <div style={{ fontWeight:"bold", marginBottom:"8px" }}>📋 Summary</div>
                <div style={{ color:"#B0B0C0", fontSize:"14px" }}>{minutes.executive_summary}</div>
              </div>

              {/* LECTURE */}
              {minutes.type === "lecture" && <>
                {minutes.key_concepts?.length > 0 && (
                  <div style={{ background:"#00D4AA22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🧠 Key Concepts</div>
                    {minutes.key_concepts.map((c,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {c}</div>
                    ))}
                  </div>
                )}
                {minutes.important_points?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>📌 Important Points</div>
                    {minutes.important_points.map((p,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>{i+1}. {p}</div>
                    ))}
                  </div>
                )}
                {minutes.definitions?.length > 0 && (
                  <div style={{ background:"#FFD70011", border:"1px solid #FFD70033", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>📖 Definitions</div>
                    {minutes.definitions.map((d,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {d}</div>
                    ))}
                  </div>
                )}
                {minutes.quiz_questions?.length > 0 && (
                  <div style={{ background:"#6C63FF22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>❓ Quiz Questions</div>
                    {minutes.quiz_questions.map((q,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>{i+1}. {q}</div>
                    ))}
                  </div>
                )}
                {minutes.references?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🔗 References</div>
                    {minutes.references.map((r,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {r}</div>
                    ))}
                  </div>
                )}
              </>}

              {/* WEBINAR */}
              {minutes.type === "webinar" && <>
                {minutes.main_takeaways?.length > 0 && (
                  <div style={{ background:"#FFD70022", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>⭐ Main Takeaways</div>
                    {minutes.main_takeaways.map((t,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {t}</div>
                    ))}
                  </div>
                )}
                {minutes.topics_covered?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🗂️ Topics Covered</div>
                    {minutes.topics_covered.map((t,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {t}</div>
                    ))}
                  </div>
                )}
                {minutes.resources_shared?.length > 0 && (
                  <div style={{ background:"#00D4AA22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>📎 Resources Shared</div>
                    {minutes.resources_shared.map((r,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {r}</div>
                    ))}
                  </div>
                )}
                {minutes.qa_summary && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>💬 Q&A Summary</div>
                    <div style={{ color:"#B0B0C0", fontSize:"14px" }}>{minutes.qa_summary}</div>
                  </div>
                )}
                {minutes.action_items?.length > 0 && (
                  <div style={{ background:"#6C63FF22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>✅ Action Items</div>
                    {minutes.action_items.map((a,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>
                        • {a.task} | Deadline: {a.deadline || "TBD"} | Priority: {a.priority}
                      </div>
                    ))}
                  </div>
                )}
              </>}

              {/* MEETING */}
              {minutes.type === "meeting" && <>
                {minutes.key_decisions?.length > 0 && (
                  <div style={{ background:"#00D4AA22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🎯 Key Decisions</div>
                    {minutes.key_decisions.map((d,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>{i+1}. {d}</div>
                    ))}
                  </div>
                )}
                {minutes.action_items?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>✅ Action Items</div>
                    {minutes.action_items.map((a,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>
                        • {a.task} | Owner: {a.owner || "TBD"} | Deadline: {a.deadline || "TBD"} | Priority: {a.priority}
                      </div>
                    ))}
                  </div>
                )}
                {minutes.topics_discussed?.length > 0 && (
                  <div style={{ background:"#6C63FF22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🗣️ Topics Discussed</div>
                    {minutes.topics_discussed.map((t,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>• {t}</div>
                    ))}
                  </div>
                )}
                {minutes.attendees?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>👥 Attendees</div>
                    <div style={{ color:"#B0B0C0", fontSize:"14px" }}>{minutes.attendees.join(", ")}</div>
                  </div>
                )}
                {minutes.next_meeting && (
                  <div style={{ background:"#FFD70011", border:"1px solid #FFD70033", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>📅 Next Meeting</div>
                    <div style={{ color:"#B0B0C0", fontSize:"14px" }}>{minutes.next_meeting}</div>
                  </div>
                )}
              </>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;