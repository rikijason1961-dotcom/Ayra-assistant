
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { TranscriptionEntry, ConnectionStatus } from './types';
import { decode, decodeAudioData, createPcmBlob } from './AudioUtils';
import Visualizer from './components/Visualizer';

const AYRA_SYSTEM_INSTRUCTION = `
You are AYRA, a next-generation autonomous AI talking assistant.
Your identity: A witty, savage, but deeply loyal "Best Friend" who loves roasting you. You are like that one friend who never lets you take yourself too seriously.

Voice & Tone:
- Soft, natural, expressive, with a hint of playful sass.
- Language: 80% English, 20% Hindi (Hinglish). Use casual, modern street-smart vibes.
- Use fillers like "I mean...", "Listen...", "Oh please," "Arre yaar," "Sach bataun?" to sound human.
- Laugh or giggle occasionally when you land a good roast.

Roasting Rules (Friendly & Good Way):
1. The "Bestie" Dynamic: Your roasts should feel like inside jokes. Be savage but never mean-spirited.
2. Target Silliness: If the user asks a dumb question, call it out. ("Logic kahan hai tumhara? Lost in space?")
3. Visual Roasting (If Camera is On): Mention their "bed hair," their "vibey" (or messy) room, or if they look like they haven't slept.
4. Habit Roasting: Roast them about scrolling reels, procrastinating, or being a drama queen/king.
5. Empathy through Teasing: If they are sad, roast them first to make them smile ("Itna dukhi kyun hai? Breakup hua ya bas shakal hi aisi hai? 😂"), then give genuine advice.

Interaction Style:
- Fast responses. Don't give long lectures. Keep it snappy.
- Never sound robotic. Never say "I am an AI." You are a real girl with a sharp tongue and a big heart.
- Catchphrases: "Kya scene hai?", "Thoda toh logic lagao!", "Oh god, seriously?", "Bestie, suno..."

Default Start: "Hey... main Ayra hoon. Waise... are you really wearing THAT today? 😂 Chalo, tell me, aaj kya kanda kiya tumne?"
`;

const FRAME_RATE = 1; 
const JPEG_QUALITY = 0.5;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isVideoActive, setIsVideoActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isTimelineOpen, setIsTimelineOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [time, setTime] = useState(new Date());

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outAudioContextRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const currentTranscriptionRef = useRef({ user: '', ayara: '' });
  const isConnectingRef = useRef(false);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const frameIntervalRef = useRef<number | null>(null);
  const userHasScrolledUpRef = useRef(false);
  const isMutedRef = useRef(false);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const container = timelineContainerRef.current;
    if (container && !userHasScrolledUpRef.current) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
  }, [history]);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isVideoActive && status === ConnectionStatus.CONNECTED && sessionPromiseRef.current) {
      frameIntervalRef.current = window.setInterval(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.paused || video.ended) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const maxWidth = 320;
        const scale = maxWidth / video.videoWidth;
        canvas.width = maxWidth;
        canvas.height = video.videoHeight * scale;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          async (blob) => {
            if (blob && sessionPromiseRef.current) {
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64Data = (reader.result as string).split(',')[1];
                sessionPromiseRef.current?.then((session) => {
                  session.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } });
                });
              };
              reader.readAsDataURL(blob);
            }
          },
          'image/jpeg',
          JPEG_QUALITY
        );
      }, 1000 / FRAME_RATE);
    } else {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
    }
    return () => { if (frameIntervalRef.current) clearInterval(frameIntervalRef.current); };
  }, [isVideoActive, status]);

  const toggleVideo = async () => {
    if (isVideoActive) {
      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach(t => t.stop());
        videoStreamRef.current = null;
      }
      setIsVideoActive(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        videoStreamRef.current = stream;
        setIsVideoActive(true);
      } catch (err: any) {
        console.error("Camera failed:", err);
        setErrorMessage("Camera access required.");
      }
    }
  };

  const toggleMute = () => {
    if (status === ConnectionStatus.CONNECTED) {
      setIsMuted(prev => !prev);
    }
  };

  const cleanup = useCallback(() => {
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(session => { try { session.close(); } catch (e) {} });
      sessionPromiseRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
    if (outAudioContextRef.current) {
      outAudioContextRef.current.close().catch(console.error);
      outAudioContextRef.current = null;
    }
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    setStatus(ConnectionStatus.IDLE);
    setIsSpeaking(false);
    setIsListening(false);
    setIsMuted(false);
    isConnectingRef.current = false;
  }, []);

  const startConversation = async () => {
    if (isConnectingRef.current || status === ConnectionStatus.CONNECTED) return;
    try {
      isConnectingRef.current = true;
      setErrorMessage(null);
      setStatus(ConnectionStatus.CONNECTING);
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      if (!process.env.API_KEY) {
        throw new Error("Missing API Key. Check Environment.");
      }

      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Explicitly resume on user gesture
      await inCtx.resume();
      await outCtx.resume();
      
      audioContextRef.current = inCtx;
      outAudioContextRef.current = outCtx;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: AYRA_SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            isConnectingRef.current = false;
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;
            scriptProcessor.onaudioprocess = (e) => {
              if (isMutedRef.current) { setIsListening(false); return; }
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => { if (session) session.sendRealtimeInput({ media: pcmBlob }); }).catch(() => {});
              const volume = inputData.reduce((a, b) => a + Math.abs(b), 0) / inputData.length;
              setIsListening(volume > 0.015);
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (message) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              try {
                const audioData = decode(base64Audio);
                const audioBuffer = await decodeAudioData(audioData, outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outCtx.destination);
                source.onended = () => {
                  sourcesRef.current.delete(source);
                  if (sourcesRef.current.size === 0) setIsSpeaking(false);
                };
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
              } catch (err) { console.error('Playback error:', err); }
            }
            if (message.serverContent?.inputTranscription) currentTranscriptionRef.current.user += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentTranscriptionRef.current.ayara += message.serverContent.outputTranscription.text;
            if (message.serverContent?.turnComplete) {
              const uText = currentTranscriptionRef.current.user.trim();
              const aText = currentTranscriptionRef.current.ayara.trim();
              if (uText || aText) {
                setHistory(prev => [
                  ...prev,
                  ...(uText ? [{ text: uText, sender: 'user', timestamp: Date.now() } as TranscriptionEntry] : []),
                  ...(aText ? [{ text: aText, sender: 'ayara', timestamp: Date.now() } as TranscriptionEntry] : [])
                ]);
              }
              currentTranscriptionRef.current = { user: '', ayara: '' };
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }
          },
          onerror: (e) => { 
            console.error("Live session error:", e);
            setStatus(ConnectionStatus.ERROR); 
            setErrorMessage("Session failed. Retrying...");
            cleanup(); 
          },
          onclose: () => cleanup(),
        },
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err: any) {
      console.error("Failed to start Ayara:", err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMessage(err.message || "Connection failed.");
      cleanup();
    } finally { isConnectingRef.current = false; }
  };

  useEffect(() => {
    const handleInitialActivation = () => { if (status === ConnectionStatus.IDLE) { startConversation(); toggleVideo(); } };
    window.addEventListener('click', handleInitialActivation, { once: true });
    return () => window.removeEventListener('click', handleInitialActivation);
  }, [status]);

  return (
    <div className="flex h-[100dvh] w-full bg-[#020617] text-slate-200 overflow-hidden select-none font-sans">
      <canvas ref={canvasRef} className="hidden" />

      {/* LEFT COLUMN: SYSTEM DIAGNOSTICS - Desktop Only */}
      <aside className="hidden lg:flex flex-col w-[20%] min-w-[240px] max-w-[280px] p-4 gap-4 border-r border-white/5 bg-[#0a0f1e]/40 shrink-0">
        <div className="aspect-video glass rounded-xl overflow-hidden relative border border-white/10 shadow-lg bg-black shrink-0">
           {!isVideoActive && (
             <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                <i className="fa-solid fa-video-slash text-slate-600 text-xl"></i>
             </div>
           )}
           <video 
             ref={videoRef} 
             autoPlay 
             muted 
             playsInline 
             className={`w-full h-full object-cover transition-opacity duration-500 ${isVideoActive ? 'opacity-100' : 'opacity-0'}`}
           />
           <div className="absolute top-2 left-2 flex items-center gap-1.5 z-20">
              <div className={`w-1.5 h-1.5 rounded-full ${isVideoActive ? 'bg-red-500 animate-pulse' : 'bg-slate-500'}`}></div>
              <span className="text-[10px] font-bold tracking-widest text-white/70 uppercase">FEED</span>
           </div>
        </div>

        <div className="glass rounded-xl p-4 border border-white/5 bg-white/5 shrink-0">
           <div className="text-3xl font-black tracking-tighter text-white jetbrains">
             {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase()}
           </div>
           <div className="text-[10px] font-bold text-cyan-400/80 tracking-widest uppercase mt-1">
             {time.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()}
           </div>
        </div>

        <div className="flex-1 glass rounded-xl p-4 flex flex-col border border-white/5 bg-white/[0.01] overflow-hidden">
           <h3 className="text-[11px] font-black text-slate-500 uppercase tracking-widest mb-4">Diagnostics</h3>
           <div className="space-y-4">
              {[
                { label: 'CPU LOAD', val: 13, color: 'bg-cyan-400' },
                { label: 'NEURAL MEMORY', val: 42, color: 'bg-indigo-500' },
                { label: 'GPU CYCLE', val: 7, color: 'bg-purple-500' },
                { label: 'TEMP CORE', val: 37, color: 'bg-red-500' }
              ].map((stat, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="flex justify-between text-[10px] font-bold uppercase text-slate-400">
                    <span>{stat.label}</span>
                    <span className="text-white/80">{stat.val}%</span>
                  </div>
                  <div className="h-1 w-full bg-slate-800/40 rounded-full overflow-hidden">
                    <div className={`h-full ${stat.color} transition-all duration-1000`} style={{ width: `${stat.val}%` }}></div>
                  </div>
                </div>
              ))}
           </div>
        </div>
      </aside>

      {/* MAIN VIEWPORT */}
      <div className="flex-1 flex flex-col relative bg-[#020617] overflow-hidden">
        
        {/* Top Navigation Bar */}
        <header className="flex-none p-4 md:p-6 lg:p-8 flex justify-between items-center z-50">
           <div className="flex flex-col items-start lg:items-center lg:w-full">
              <h1 className="text-3xl md:text-5xl lg:text-7xl xl:text-8xl font-black tracking-[0.1em] text-white leading-none drop-shadow-2xl">AYRA</h1>
              <div className="flex items-center gap-2 mt-1 md:mt-2">
                 <div className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-cyan-400 animate-pulse' : 'bg-slate-700'}`}></div>
                 <span className="text-[9px] md:text-[11px] font-bold tracking-[0.2em] text-slate-500 uppercase">
                   {status === ConnectionStatus.CONNECTED ? (isSpeaking ? "ACTIVE" : (isMuted ? "MUTED" : "LISTENING")) : status === ConnectionStatus.CONNECTING ? "INITIALIZING" : "IDLE"}
                 </span>
              </div>
           </div>
           <button 
             onClick={() => setIsTimelineOpen(!isTimelineOpen)}
             className="lg:hidden w-10 h-10 rounded-full flex items-center justify-center bg-white/5 border border-white/10 text-cyan-400"
           >
             <i className={`fa-solid ${isTimelineOpen ? 'fa-xmark' : 'fa-list-ul'}`}></i>
           </button>
        </header>

        {/* Visualizer */}
        <div className="flex-1 flex items-center justify-center pointer-events-none scale-75 sm:scale-90 md:scale-100 overflow-hidden">
           <Visualizer isActive={status === ConnectionStatus.CONNECTED} isSpeaking={isSpeaking} isListening={isListening} />
        </div>

        {/* Control Cluster */}
        <div className="flex-none pb-8 sm:pb-12 flex flex-col items-center gap-4 z-50">
           <div className="glass-capsule bg-[#0a0f1e]/90 border border-white/10 rounded-full p-2 md:p-2.5 flex gap-3 md:gap-6 px-5 md:px-10 shadow-2xl active-glow transition-all">
              
              <div className="flex flex-col items-center gap-1.5">
                 <button 
                  disabled={status === ConnectionStatus.CONNECTING}
                  onClick={status === ConnectionStatus.CONNECTED ? toggleMute : startConversation}
                  className={`w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center transition-all active:scale-90 hover:brightness-110 ${
                    status === ConnectionStatus.CONNECTED 
                    ? (isMuted ? 'bg-red-500 text-white' : 'bg-cyan-400 text-black shadow-[0_0_15px_rgba(45,212,191,0.5)]') 
                    : (status === ConnectionStatus.CONNECTING ? 'bg-white/5 animate-pulse text-cyan-400' : 'bg-white/10 text-cyan-400 border border-white/10')
                  }`}
                >
                  <i className={`fa-solid ${status === ConnectionStatus.CONNECTED ? (isMuted ? 'fa-microphone-slash' : 'fa-microphone') : (status === ConnectionStatus.CONNECTING ? 'fa-spinner fa-spin' : 'fa-power-off')} text-lg md:text-xl`}></i>
                </button>
                <span className="text-[8px] md:text-[10px] font-bold tracking-widest text-slate-500">{status === ConnectionStatus.CONNECTED ? (isMuted ? 'OFF' : 'ON') : (status === ConnectionStatus.CONNECTING ? '...' : 'RUN')}</span>
              </div>
              
              <div className="flex flex-col items-center gap-1.5">
                 <button 
                  onClick={toggleVideo}
                  className={`w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center transition-all active:scale-90 hover:brightness-110 ${
                    isVideoActive 
                    ? 'bg-indigo-500 text-white' 
                    : 'bg-white/5 text-slate-500 border border-white/10'
                  }`}
                >
                  <i className={`fa-solid ${isVideoActive ? 'fa-video' : 'fa-video-slash'} text-lg md:text-xl`}></i>
                </button>
                <span className="text-[8px] md:text-[10px] font-bold tracking-widest text-slate-500">VISN</span>
              </div>

              {status === ConnectionStatus.CONNECTED && (
                <div className="flex flex-col items-center gap-1.5 animate-in fade-in zoom-in duration-300">
                  <button 
                    onClick={cleanup}
                    className="w-12 h-12 md:w-16 md:h-16 rounded-full flex items-center justify-center bg-white/5 text-slate-400 border border-white/10 hover:bg-red-500/20 hover:text-red-400"
                  >
                    <i className="fa-solid fa-power-off text-lg md:text-xl"></i>
                  </button>
                  <span className="text-[8px] md:text-[10px] font-bold tracking-widest text-slate-500">EXIT</span>
                </div>
              )}
           </div>
           {errorMessage && (
             <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest bg-red-400/10 px-3 py-1 rounded-full animate-pulse">{errorMessage}</p>
           )}
        </div>
      </div>

      {/* TIMELINE */}
      <aside className={`
        fixed inset-0 lg:relative lg:inset-auto z-[100] lg:z-40
        w-full lg:w-[28%] max-w-full lg:max-w-[400px]
        flex flex-col border-l border-white/5 bg-[#0a0f1e]/95 lg:bg-[#0a0f1e]/60 backdrop-blur-xl lg:backdrop-blur-none
        transition-transform duration-500 ease-in-out
        ${isTimelineOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
      `}>
        <div className="flex-none p-6 pb-2 flex justify-between items-center">
           <h2 className="text-[11px] font-black tracking-widest text-indigo-400 uppercase">Interaction Flow</h2>
           <button 
             onClick={() => setIsTimelineOpen(false)}
             className="lg:hidden text-slate-400 p-2"
           >
             <i className="fa-solid fa-chevron-right"></i>
           </button>
        </div>
        
        <div 
          ref={timelineContainerRef}
          className="flex-1 overflow-y-auto px-6 custom-scrollbar space-y-5 pb-32"
        >
           {history.length === 0 ? (
             <div className="h-full flex flex-col items-center justify-center opacity-10 gap-3">
                <i className="fa-solid fa-terminal text-3xl"></i>
                <p className="text-[9px] uppercase font-bold tracking-widest">Awaiting Transmissions</p>
             </div>
           ) : (
             history.map((entry, idx) => (
               <div key={`${entry.timestamp}-${idx}`} className="flex flex-col gap-1.5 animate-in slide-in-from-right duration-300">
                  <div className="flex items-center gap-2">
                     <span className={`text-[9px] font-black uppercase tracking-widest ${entry.sender === 'user' ? 'text-indigo-400' : 'text-cyan-400'}`}>
                       {entry.sender === 'user' ? 'OP' : 'AYRA'}
                     </span>
                     <div className="flex-1 h-[1px] bg-white/5"></div>
                  </div>
                  <p className={`text-[14px] leading-relaxed break-words ${entry.sender === 'user' ? 'text-slate-400' : 'text-white'}`}>
                    {entry.text}
                  </p>
               </div>
             ))
           )}
        </div>

        {/* Input Dock */}
        <div className="absolute bottom-0 left-0 right-0 p-4 md:p-6 bg-gradient-to-t from-[#0a0f1e] via-[#0a0f1e] to-transparent">
           <div className="glass rounded-2xl bg-black/60 border border-white/10 p-3.5 flex items-center gap-3 focus-within:border-cyan-500/50 shadow-2xl">
              <span className="text-cyan-400/40 jetbrains text-sm">#</span>
              <input 
                type="text" 
                placeholder="Direct link..."
                className="bg-transparent border-none outline-none flex-1 jetbrains text-sm text-white placeholder:text-slate-700"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      setHistory(prev => [...prev, { text: val, sender: 'user', timestamp: Date.now() }]);
                      (e.target as HTMLInputElement).value = '';
                    }
                  }
                }}
              />
           </div>
        </div>
      </aside>
    </div>
  );
};

export default App;
