import React, { useState, useRef, useEffect } from 'react';
import {
  Mic, MicOff, FileText, Download, Play, Square,
  Users, CheckSquare, ListTodo, AlertCircle, Copy,
  Check, Edit3, Save, RefreshCw, Sparkles, FileDown
} from 'lucide-react';

function App() {
  // Recording & Connection State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // disconnected, connecting, connected, error
  const [errorMsg, setErrorMsg] = useState('');

  // Generated Minutes State
  const [minutes, setMinutes] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Copy State
  const [copiedTranscript, setCopiedTranscript] = useState(false);
  const [copiedMinutes, setCopiedMinutes] = useState(false);

  // Refs for Web Audio & WebSocket
  const socketRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const transcriptEndRef = useRef(null);

  // Auto-scroll transcript to bottom
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript, interimTranscript]);

  // Timer for recording duration
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
      setRecordingDuration(0);
    }
    return () => clearInterval(timerRef.current);
  }, [isRecording]);

  // Format duration helper (MM:SS)
  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Check backend health on page load and periodically
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const res = await fetch('http://localhost:8000/');
        if (res.ok) {
          setConnectionStatus('connected');
          setErrorMsg('');
        } else {
          setConnectionStatus('error');
        }
      } catch {
        setConnectionStatus('disconnected');
      }
    };

    checkBackend();
    const interval = setInterval(checkBackend, 5000);
    return () => clearInterval(interval);
  }, []);

  // Open a fresh WebSocket for each recording session
  const openRecordingSocket = () => {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://localhost:8000/ws/transcribe');
      socketRef.current = socket;

      socket.onopen = () => resolve(socket);

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const alternatives = data.channel?.alternatives?.[0];
          const text = alternatives?.transcript || '';
          if (text) {
            if (data.is_final) {
              setTranscript((prev) => {
                const trimmed = prev.trim();
                return trimmed ? trimmed + ' ' + text : text;
              });
              setInterimTranscript('');
            } else {
              setInterimTranscript(text);
            }
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      socket.onerror = () => {
        reject(new Error('WebSocket connection failed. Is the backend running?'));
      };

      socket.onclose = () => {
        // Socket closed — no status change needed here since we manage it via health checks
      };
    });
  };

  // Start Recording
  const startRecording = async () => {
    setErrorMsg('');

    try {
      // 1. Open a fresh WebSocket for this recording session
      let socket;
      try {
        socket = await openRecordingSocket();
      } catch (err) {
        setErrorMsg(err.message);
        return;
      }

      // 2. Get user media (microphone)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 3. Start AudioContext for PCM audio
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768,
            Math.min(32767, float32[i] * 32768));
        }
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(int16.buffer);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      mediaRecorderRef.current = processor;
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
      setErrorMsg('Microphone access denied.');
    }
  };

  // Stop Recording
  const stopRecording = () => {
    setIsRecording(false);

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.disconnect();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }

    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
  };


  // Copy Transcript to Clipboard
  const copyTranscript = () => {
    navigator.clipboard.writeText(transcript);
    setCopiedTranscript(true);
    setTimeout(() => setCopiedTranscript(false), 2000);
  };

  // Generate Minutes from Transcript
  const generateMinutes = async () => {
    if (!transcript.trim()) {
      setErrorMsg('Transcript is empty. Please record some audio or type a transcript first.');
      return;
    }

    setIsGenerating(true);
    setErrorMsg('');

    try {
      const response = await fetch('http://localhost:8000/api/generate-minutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ transcript }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || 'Failed to generate minutes');
      }

      const data = await response.json();
      setMinutes(data);
    } catch (err) {
      console.error('Error generating minutes:', err);
      setErrorMsg(err.message || 'Failed to generate meeting minutes. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  // Export PDF
  const exportPDF = async () => {
    if (!minutes) return;

    setIsExporting(true);
    setErrorMsg('');

    try {
      const response = await fetch('http://localhost:8000/api/export-pdf', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(minutes),
      });

      if (!response.ok) {
        throw new Error('Failed to generate PDF');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${minutes.meeting_title.replace(/\s+/g, '_')}_Minutes.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error exporting PDF:', err);
      setErrorMsg('Failed to export PDF. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  // Handle Minutes Field Changes (Editing)
  const handleMinutesChange = (field, value) => {
    setMinutes((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  // Handle Action Item Changes
  const handleActionItemChange = (index, field, value) => {
    setMinutes((prev) => {
      const updatedActionItems = [...prev.action_items];
      updatedActionItems[index] = {
        ...updatedActionItems[index],
        [field]: value
      };
      return {
        ...prev,
        action_items: updatedActionItems
      };
    });
  };

  // Add Action Item
  const addActionItem = () => {
    setMinutes((prev) => ({
      ...prev,
      action_items: [...prev.action_items, { task: '', assignee: 'Unassigned' }]
    }));
  };

  // Remove Action Item
  const removeActionItem = (index) => {
    setMinutes((prev) => ({
      ...prev,
      action_items: prev.action_items.filter((_, i) => i !== index)
    }));
  };

  // Copy Minutes JSON to Clipboard
  const copyMinutesJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(minutes, null, 2));
    setCopiedMinutes(true);
    setTimeout(() => setCopiedMinutes(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      {/* Background Glows */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute bottom-10 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl pointer-events-none"></div>

      {/* Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-tr from-indigo-500 to-purple-500 p-2.5 rounded-xl shadow-lg shadow-indigo-500/20">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-white via-indigo-200 to-purple-300 bg-clip-text text-transparent m-0 tracking-tight">
                MinutesAI
              </h1>
              <p className="text-xs text-slate-400 font-medium">Real-time Meeting Assistant</p>
            </div>
          </div>

          {/* Connection Status Indicator */}
          <div className="flex items-center gap-2.5 bg-slate-900/80 border border-slate-800 px-3.5 py-1.5 rounded-full">
            <span className={`w-2 h-2 rounded-full ${connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
              connectionStatus === 'connecting' ? 'bg-amber-500 animate-pulse' :
                connectionStatus === 'error' ? 'bg-rose-500' : 'bg-slate-500'
              }`} />
            <span className="text-xs font-semibold text-slate-300 capitalize">
              {connectionStatus === 'connected' ? 'Live Transcribing' : connectionStatus}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Error Alert */}
        {errorMsg && (
          <div className="mb-6 bg-rose-950/40 border border-rose-800/60 text-rose-200 px-4 py-3.5 rounded-xl flex items-start gap-3 shadow-lg shadow-rose-950/10">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold">An error occurred</p>
              <p className="text-xs text-rose-300/90 mt-0.5">{errorMsg}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">

          {/* Left Column: Recording & Transcript */}
          <div className="lg:col-span-5 flex flex-col gap-6">

            {/* Recording Controls Card */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-sm flex flex-col gap-5 shadow-xl">
              <h2 className="text-lg font-bold text-slate-200 flex items-center gap-2">
                <Mic className="w-5 h-5 text-indigo-400" />
                Capture Meeting Audio
              </h2>

              {/* Visualizer & Timer */}
              <div className="bg-slate-950/80 border border-slate-800/60 rounded-xl p-6 flex flex-col items-center justify-center min-h-[140px] relative overflow-hidden">
                {isRecording ? (
                  <>
                    {/* Animated Waveform */}
                    <div className="flex items-end gap-1 h-12 mb-4">
                      {[...Array(12)].map((_, i) => (
                        <div
                          key={i}
                          className="w-1.5 bg-gradient-to-t from-indigo-500 to-purple-500 rounded-full animate-bounce"
                          style={{
                            height: `${Math.random() * 100}%`,
                            animationDuration: `${0.5 + Math.random() * 0.8}s`,
                            animationDelay: `${i * 0.05}s`
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-2xl font-mono font-bold text-indigo-400 tracking-wider">
                      {formatDuration(recordingDuration)}
                    </span>
                    <span className="text-xs text-slate-400 mt-1 font-medium animate-pulse">
                      Streaming audio to Deepgram...
                    </span>
                  </>
                ) : (
                  <div className="text-center py-4">
                    <div className="w-12 h-12 bg-slate-900 rounded-full flex items-center justify-center mx-auto mb-3 border border-slate-800">
                      <MicOff className="w-6 h-6 text-slate-500" />
                    </div>
                    <p className="text-sm font-semibold text-slate-300">Microphone Inactive</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-[200px] mx-auto">
                      Click start below to begin real-time transcription.
                    </p>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-4">
                {!isRecording ? (
                  <button
                    onClick={startRecording}
                    className="flex-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-[0.98]"
                  >
                    <Play className="w-5 h-5 fill-current" />
                    Start Recording
                  </button>
                ) : (
                  <button
                    onClick={stopRecording}
                    className="flex-1 bg-rose-600 hover:bg-rose-500 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 shadow-lg shadow-rose-600/20 active:scale-[0.98]"
                  >
                    <Square className="w-5 h-5 fill-current" />
                    Stop Recording
                  </button>
                )}
              </div>
            </div>

            {/* Transcript Card */}
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-sm flex flex-col flex-grow min-h-[400px] shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-slate-200 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-400" />
                  Live Transcript
                </h2>
                <div className="flex gap-2">
                  <button
                    onClick={copyTranscript}
                    disabled={!transcript}
                    className="p-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-300 rounded-lg transition-colors"
                    title="Copy Transcript"
                  >
                    {copiedTranscript ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => { if (window.confirm('Clear transcript?')) setTranscript(''); }}
                    disabled={!transcript}
                    className="text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-300 px-3 py-2 rounded-lg transition-colors font-semibold"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* Transcript Text Area */}
              <div className="flex-grow flex flex-col bg-slate-950/60 border border-slate-800/60 rounded-xl p-4 relative">
                <textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  placeholder="Your live meeting transcript will appear here. You can also type or edit directly in this box..."
                  className="w-full h-full flex-grow bg-transparent text-slate-300 text-sm leading-relaxed resize-none focus:outline-none placeholder:text-slate-600"
                />

                {/* Interim/Real-time text overlay */}
                {interimTranscript && (
                  <p className="text-sm text-indigo-400/80 italic mt-2 animate-pulse">
                    {interimTranscript}...
                  </p>
                )}
                <div ref={transcriptEndRef} />
              </div>

              {/* Generate Minutes Button */}
              <button
                onClick={generateMinutes}
                disabled={isGenerating || !transcript.trim()}
                className="mt-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin text-indigo-400" />
                    Analyzing Transcript with Claude...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5 text-indigo-400" />
                    Generate Meeting Minutes
                  </>
                )}
              </button>
            </div>

          </div>

          {/* Right Column: Generated Minutes */}
          <div className="lg:col-span-7">
            <div className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-sm min-h-[620px] flex flex-col shadow-xl">

              {/* Header of Minutes Card */}
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-4 mb-6">
                <h2 className="text-lg font-bold text-slate-200 flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-purple-400" />
                  Meeting Minutes
                </h2>
                {minutes && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setIsEditing(!isEditing)}
                      className="flex items-center gap-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-lg transition-colors font-semibold"
                    >
                      {isEditing ? (
                        <>
                          <Save className="w-3.5 h-3.5 text-emerald-400" />
                          Done Editing
                        </>
                      ) : (
                        <>
                          <Edit3 className="w-3.5 h-3.5" />
                          Edit Minutes
                        </>
                      )}
                    </button>
                    <button
                      onClick={copyMinutesJSON}
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors"
                      title="Copy JSON"
                    >
                      {copiedMinutes ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={exportPDF}
                      disabled={isExporting}
                      className="flex items-center gap-1.5 text-xs bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white px-3.5 py-2 rounded-lg transition-all font-semibold shadow-md shadow-indigo-600/10"
                    >
                      {isExporting ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <FileDown className="w-3.5 h-3.5" />
                      )}
                      Export PDF
                    </button>
                  </div>
                )}
              </div>

              {/* Content Area */}
              {isGenerating ? (
                <div className="flex-grow flex flex-col items-center justify-center py-20">
                  <div className="relative w-20 h-20 mb-6">
                    <div className="absolute inset-0 border-4 border-indigo-500/20 rounded-full"></div>
                    <div className="absolute inset-0 border-4 border-t-indigo-500 rounded-full animate-spin"></div>
                    <Sparkles className="w-8 h-8 text-indigo-400 absolute inset-0 m-auto animate-pulse" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-300">Claude is analyzing your meeting</h3>
                  <p className="text-sm text-slate-500 mt-2 max-w-sm text-center">
                    Extracting key decisions, action items, attendees, and creating a professional summary.
                  </p>
                </div>
              ) : minutes ? (
                <div className="flex-grow flex flex-col gap-6">

                  {/* Meeting Title */}
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1.5">Meeting Title</label>
                    {isEditing ? (
                      <input
                        type="text"
                        value={minutes.meeting_title}
                        onChange={(e) => handleMinutesChange('meeting_title', e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:border-indigo-500"
                      />
                    ) : (
                      <h3 className="text-xl font-bold text-slate-100">{minutes.meeting_title}</h3>
                    )}
                  </div>

                  {/* Attendees */}
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      <span className="flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5" /> Attendees
                      </span>
                    </label>
                    {isEditing ? (
                      <input
                        type="text"
                        value={minutes.attendees.join(', ')}
                        onChange={(e) => handleMinutesChange('attendees', e.target.value.split(',').map(s => s.trim()))}
                        placeholder="Comma-separated list of attendees"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:border-indigo-500"
                      />
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {minutes.attendees.length > 0 ? (
                          minutes.attendees.map((attendee, i) => (
                            <span key={i} className="bg-slate-800/80 border border-slate-700/50 text-slate-300 text-xs px-3 py-1 rounded-full font-medium">
                              {attendee}
                            </span>
                          ))
                        ) : (
                          <span className="text-sm text-slate-500 italic">No attendees identified</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Executive Summary */}
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1.5">Executive Summary</label>
                    {isEditing ? (
                      <textarea
                        value={minutes.executive_summary}
                        onChange={(e) => handleMinutesChange('executive_summary', e.target.value)}
                        rows={4}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:border-indigo-500 resize-none"
                      />
                    ) : (
                      <p className="text-sm text-slate-300 leading-relaxed bg-slate-950/40 border border-slate-800/40 rounded-xl p-4">
                        {minutes.executive_summary}
                      </p>
                    )}
                  </div>

                  {/* Topics Discussed */}
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      <span className="flex items-center gap-1.5">
                        <ListTodo className="w-3.5 h-3.5" /> Topics Discussed
                      </span>
                    </label>
                    {isEditing ? (
                      <textarea
                        value={minutes.topics_discussed.join('\n')}
                        onChange={(e) => handleMinutesChange('topics_discussed', e.target.value.split('\n'))}
                        placeholder="One topic per line"
                        rows={3}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:border-indigo-500"
                      />
                    ) : (
                      <ul className="space-y-2">
                        {minutes.topics_discussed.map((topic, i) => (
                          <li key={i} className="text-sm text-slate-300 flex items-start gap-2">
                            <span className="text-indigo-400 mt-0.5">•</span>
                            <span>{topic}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Key Decisions */}
                  <div>
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                      <span className="flex items-center gap-1.5">
                        <CheckSquare className="w-3.5 h-3.5" /> Key Decisions
                      </span>
                    </label>
                    {isEditing ? (
                      <textarea
                        value={minutes.key_decisions.join('\n')}
                        onChange={(e) => handleMinutesChange('key_decisions', e.target.value.split('\n'))}
                        placeholder="One decision per line"
                        rows={3}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-slate-200 text-sm focus:outline-none focus:border-indigo-500"
                      />
                    ) : (
                      <ul className="space-y-2">
                        {minutes.key_decisions.map((decision, i) => (
                          <li key={i} className="text-sm text-slate-300 flex items-start gap-2">
                            <span className="text-emerald-400 mt-0.5">✔</span>
                            <span>{decision}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Action Items */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Action Items</label>
                      {isEditing && (
                        <button
                          onClick={addActionItem}
                          className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
                        >
                          + Add Item
                        </button>
                      )}
                    </div>

                    <div className="border border-slate-800/80 rounded-xl overflow-hidden">
                      <table className="w-full text-left border-collapse text-sm">
                        <thead>
                          <tr className="bg-slate-950 border-b border-slate-800">
                            <th className="px-4 py-3 font-semibold text-slate-400">Task</th>
                            <th className="px-4 py-3 font-semibold text-slate-400 w-1/3">Assignee</th>
                            {isEditing && <th className="px-4 py-3 w-12"></th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {minutes.action_items.map((item, i) => (
                            <tr key={i} className="hover:bg-slate-900/20">
                              <td className="px-4 py-3 text-slate-300">
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={item.task}
                                    onChange={(e) => handleActionItemChange(i, 'task', e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                                  />
                                ) : (
                                  item.task
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-300">
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={item.assignee}
                                    onChange={(e) => handleActionItemChange(i, 'assignee', e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-slate-200 text-xs focus:outline-none focus:border-indigo-500"
                                  />
                                ) : (
                                  <span className="bg-slate-800/50 border border-slate-700/30 text-slate-300 text-xs px-2.5 py-1 rounded-md font-medium">
                                    {item.assignee}
                                  </span>
                                )}
                              </td>
                              {isEditing && (
                                <td className="px-4 py-3 text-center">
                                  <button
                                    onClick={() => removeActionItem(i)}
                                    className="text-rose-500 hover:text-rose-400 text-xs font-bold"
                                  >
                                    Remove
                                  </button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                </div>
              ) : (
                <div className="flex-grow flex flex-col items-center justify-center py-20 text-center">
                  <div className="w-16 h-16 bg-slate-950 border border-slate-800 rounded-2xl flex items-center justify-center mb-4 shadow-inner">
                    <Sparkles className="w-8 h-8 text-slate-600" />
                  </div>
                  <h3 className="text-base font-bold text-slate-300">No Minutes Generated Yet</h3>
                  <p className="text-xs text-slate-500 mt-1.5 max-w-xs leading-relaxed">
                    Record a meeting or type a transcript on the left, then click "Generate Meeting Minutes" to use Claude's intelligence.
                  </p>
                </div>
              )}

            </div>
          </div>

        </div>
      </main>
    </div>
  );
}

export default App;
