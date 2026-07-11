import { useState, useRef, useEffect } from "react";

const BACKEND_URL = "http://localhost:8000";
const WS_URL = "ws://localhost:8000/ws/transcribe";

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
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

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript, interimTranscript]);

  const openSocket = () => {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(WS_URL);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { setIsConnected(true); resolve(socket); };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "transcript") {
            if (data.is_final) {
              setTranscript((prev) => prev + " " + data.text);
              setInterimTranscript("");
            } else {
              setInterimTranscript(data.text);
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
    setInterimTranscript("");
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
    if (workletNodeRef.current) workletNodeRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (socketRef.current) socketRef.current.close();
  };

  const generateMinutes = async () => {
    const fullTranscript = transcript + " " + interimTranscript;
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
              <button onClick={() => { setTranscript(""); setInterimTranscript(""); }}
                style={{ background:"transparent", border:"1px solid #2A2A3E", color:"#B0B0C0", padding:"4px 10px", borderRadius:"6px", cursor:"pointer" }}>
                Clear
              </button>
            </div>
            <div style={{ minHeight:"200px", maxHeight:"300px", overflowY:"auto", lineHeight:"1.6", fontSize:"14px" }}>
              {transcript || interimTranscript ? (
                <div>
                  <span>{transcript}</span>
                  <span style={{ color:"#6C63FF" }}> {interimTranscript}</span>
                </div>
              ) : (
                <span style={{ color:"#B0B0C0" }}>Your live transcript will appear here...</span>
              )}
              <div ref={transcriptEndRef} />
            </div>
            <button onClick={generateMinutes}
              disabled={isGenerating || (!transcript && !interimTranscript)}
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
                  <div style={{ background:"#00D4AA22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>📋 Topics Covered</div>
                    {minutes.topics_covered.map((t,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>{i+1}. {t}</div>
                    ))}
                  </div>
                )}
                {minutes.qa_summary && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"8px" }}>💬 Q&A Summary</div>
                    <div style={{ color:"#B0B0C0", fontSize:"14px" }}>{minutes.qa_summary}</div>
                  </div>
                )}
                {minutes.action_items?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🎯 Action Items</div>
                    {minutes.action_items.map((item,i) => (
                      <div key={i} style={{ background:"#0F0F1A", padding:"12px", borderRadius:"8px", marginBottom:"8px" }}>
                        <div style={{ fontWeight:"bold", fontSize:"14px" }}>{item.task}</div>
                        <div style={{ display:"flex", gap:"12px", marginTop:"6px", fontSize:"12px", color:"#B0B0C0" }}>
                          <span>📅 {item.deadline}</span>
                          <span style={{ color: item.priority==="high"?"#FF4757":item.priority==="medium"?"#FFD700":"#00D4AA" }}>● {item.priority}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>}

             {/* MEETING */}
              {(minutes.type === "meeting" || !minutes.type) && <>
                {minutes.key_decisions?.length > 0 && (
                  <div style={{ background:"#00D4AA22", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>✅ Key Decisions</div>
                    {minutes.key_decisions.map((d,i) => (
                      <div key={i} style={{ color:"#B0B0C0", fontSize:"14px", marginBottom:"6px" }}>{i+1}. {d}</div>
                    ))}
                  </div>
                )}
                {minutes.action_items?.length > 0 && (
                  <div style={{ background:"#1A1A2E", border:"1px solid #2A2A3E", padding:"16px", borderRadius:"8px", marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"12px" }}>🎯 Action Items</div>
                    {minutes.action_items.map((item,i) => (
                      <div key={i} style={{ background:"#0F0F1A", padding:"12px", borderRadius:"8px", marginBottom:"8px" }}>
                        <div style={{ fontWeight:"bold", fontSize:"14px" }}>{item.task}</div>
                        <div style={{ display:"flex", gap:"12px", marginTop:"6px", fontSize:"12px", color:"#B0B0C0" }}>
                          <span>👤 {item.owner}</span>
                          <span>📅 {item.deadline}</span>
                          <span style={{ color: item.priority==="high"?"#FF4757":item.priority==="medium"?"#FFD700":"#00D4AA" }}>● {item.priority}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {minutes.attendees?.length > 0 && (
                  <div style={{ marginBottom:"16px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"8px" }}>👥 Attendees</div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:"8px" }}>
                      {minutes.attendees.map((a,i) => (
                        <span key={i} style={{ background:"#2A2A3E", padding:"4px 12px", borderRadius:"20px", fontSize:"13px" }}>{a}</span>
                      ))}
                    </div>
                  </div>
                )}
                {minutes.next_meeting && (
                  <div style={{ background:"#6C63FF22", padding:"12px", borderRadius:"8px" }}>
                    <div style={{ fontWeight:"bold", marginBottom:"4px" }}>📅 Next Meeting</div>
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