"use client";

import React, { useState, useCallback, useRef } from 'react';
import { UploadIcon, AudioFileIcon, SpinnerIcon, ErrorIcon, CopyIcon, CheckIcon, CancelIcon, DownloadIcon, LockIcon } from '../components/icons';

// --- Constants ---
const CHUNK_DURATION_SECONDS = 720; 
const CHUNK_OVERLAP_SECONDS = 10;

// --- Audio Utility Functions ---
const writeString = (view: DataView, offset: number, str: string) => {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
};

const audioBufferToWav = (buffer: AudioBuffer): Blob => {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let offset = 0;
  let pos = 0;

  writeString(view, pos, 'RIFF'); pos += 4;
  view.setUint32(pos, length - 8, true); pos += 4;
  writeString(view, pos, 'WAVE'); pos += 4;
  writeString(view, pos, 'fmt '); pos += 4;
  view.setUint32(pos, 16, true); pos += 4;
  view.setUint16(pos, 1, true); pos += 2;
  view.setUint16(pos, numOfChan, true); pos += 2;
  view.setUint32(pos, buffer.sampleRate, true); pos += 4;
  view.setUint32(pos, buffer.sampleRate * 2 * numOfChan, true); pos += 4;
  view.setUint16(pos, numOfChan * 2, true); pos += 2;
  view.setUint16(pos, 16, true); pos += 2;
  writeString(view, pos, 'data'); pos += 4;
  view.setUint32(pos, length - pos - 4, true); pos += 4;

  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (let i = 0; i < numOfChan; i++) {
      let sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([view], { type: 'audio/wav' });
};

const getAudioDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
        const audio = document.createElement('audio');
        const objectUrl = URL.createObjectURL(file);
        audio.src = objectUrl;
        
        audio.onloadedmetadata = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(audio.duration);
        };
        
        audio.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(0);
        };
    });
};

const sliceAudio = async (file: File): Promise<Blob[]> => {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
      const fileBuffer = await file.arrayBuffer();
      const originalBuffer = await audioContext.decodeAudioData(fileBuffer);
      const { duration } = originalBuffer;
      
      const TARGET_SAMPLE_RATE = 16000;
      const TARGET_CHANNELS = 1;

      const chunks: Blob[] = [];
      let currentTime = 0;

      while (currentTime < duration) {
        let endTime = currentTime + CHUNK_DURATION_SECONDS;
        if (endTime > duration) endTime = duration;

        const chunkDuration = endTime - currentTime;
        if (chunkDuration <= 0) break;

        const offlineCtx = new OfflineAudioContext(
            TARGET_CHANNELS, 
            Math.ceil(chunkDuration * TARGET_SAMPLE_RATE), 
            TARGET_SAMPLE_RATE
        );

        const source = offlineCtx.createBufferSource();
        source.buffer = originalBuffer;
        source.connect(offlineCtx.destination);
        source.start(0, currentTime, chunkDuration);

        const renderedBuffer = await offlineCtx.startRendering();
        const wavBlob = audioBufferToWav(renderedBuffer);
        chunks.push(wavBlob);

        currentTime = endTime - CHUNK_OVERLAP_SECONDS;
        if (currentTime >= duration) break;
      }
      return chunks;
  } finally {
      await audioContext.close();
  }
};

type AppMode = 'single' | 'batch';

export default function Home() {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
    const [accessCodeInput, setAccessCodeInput] = useState<string>("");
    const [authError, setAuthError] = useState<string | null>(null);
    // Store access code to send to backend for verification
    const [storedAccessCode, setStoredAccessCode] = useState<string>(""); 

    const [mode, setMode] = useState<AppMode>('single');
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [fileCountInput, setFileCountInput] = useState<string>("");
    const [batchFiles, setBatchFiles] = useState<(File | null)[]>([]);
    const [confirmedBatchCount, setConfirmedBatchCount] = useState<number>(0);

    const [speakerNames, setSpeakerNames] = useState<string>("");
    const [transcription, setTranscription] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<boolean>(false);
    const [progress, setProgress] = useState<{ current: number; total: number; detail?: string } | null>(null);
    const [statusMessage, setStatusMessage] = useState<string>('');
    
    const abortControllerRef = useRef<AbortController | null>(null);

    // This calls the Next.js API route instead of Gemini directly
    const callBackendAPI = async (audioData: string, mimeType: string) => {
        const response = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                audioData,
                mimeType,
                speakerNames,
                accessCode: storedAccessCode // Send code to server for validation
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Server error');
        }

        const data = await response.json();
        return data.transcription;
    };

    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault();
        // In a real app, we might verify against an API here, 
        // but for now we store it and let the transcription API validate it.
        if (accessCodeInput.length > 0) {
            setIsAuthenticated(true);
            setStoredAccessCode(accessCodeInput);
            setAuthError(null);
        } else {
            setAuthError("Please enter a code.");
        }
    };

    const handleModeChange = (newMode: AppMode) => {
        setMode(newMode);
        resetState();
        setFileCountInput("");
        setConfirmedBatchCount(0);
        setBatchFiles([]);
    };

    const handleSetFileCount = () => {
        const count = parseInt(fileCountInput, 10);
        if (isNaN(count) || count < 1) {
            setError("Please enter a valid number greater than 0.");
            return;
        }
        if (count > 15) {
            setError("Maximum of 15 files allowed.");
            return;
        }
        setError(null);
        setConfirmedBatchCount(count);
        setBatchFiles(new Array(count).fill(null));
    };

    const handleSingleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            setError(null);
            setAudioFile(file);
            setTranscription(null);
        }
    };

    const handleBatchFileChange = (index: number, event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const newBatchFiles = [...batchFiles];
            newBatchFiles[index] = file;
            setBatchFiles(newBatchFiles);
            setError(null);
        }
    };

    const fileToBase64 = (file: File): Promise<{ mimeType: string; data: string }> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => {
                const result = reader.result as string;
                const base64Data = result.split(',')[1];
                resolve({ mimeType: file.type, data: base64Data });
            };
            reader.onerror = (error) => reject(error);
        });
    };

    const handleTranscribe = async () => {
        if (mode === 'single' && !audioFile) {
            setError("Please select an audio file.");
            return;
        }
        if (mode === 'batch') {
            if (batchFiles.some(f => f === null)) {
                setError("Please upload all required files.");
                return;
            }
            if (batchFiles.length === 0) {
                setError("No files selected.");
                return;
            }
        }

        setIsLoading(true);
        setError(null);
        setTranscription(null);
        setProgress(null);
        
        abortControllerRef.current = new AbortController();
        const signal = abortControllerRef.current.signal;

        try {
            if (mode === 'single' && audioFile) {
                await processSingleFile(audioFile, signal);
            } else if (mode === 'batch') {
                await processBatchFiles(batchFiles as File[], signal);
            }
        } catch (err) {
            if (!signal.aborted) {
                console.error(err);
                const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred.";
                if (errorMessage.includes("Invalid Access Code")) {
                    setIsAuthenticated(false);
                    setAuthError("Session expired or invalid code. Please login again.");
                }
                setError(errorMessage);
            }
        } finally {
            if (!signal.aborted) {
                setIsLoading(false);
                setProgress(null);
                setTimeout(() => setStatusMessage(prev => prev.includes('cancelled') ? prev : ''), 3000);
            }
        }
    };

    const processSingleFile = async (file: File, signal: AbortSignal) => {
        setStatusMessage('Analyzing audio file...');
        const duration = await getAudioDuration(file);
        
        if (signal.aborted) return;

        if (duration < CHUNK_DURATION_SECONDS && duration > 0) {
            setStatusMessage('Transcribing audio (Single pass)...');
            const { mimeType, data } = await fileToBase64(file);
            if (signal.aborted) return;

            const result = await callBackendAPI(data, mimeType);
            if (signal.aborted) return;

            setTranscription(result);
            setStatusMessage('Transcription complete!');
        } else {
            setStatusMessage('Processing long audio file (resampling & slicing)...');
            let audioChunks: Blob[] = [];
            try {
                audioChunks = await sliceAudio(file);
            } catch (e) {
                throw new Error("Failed to process audio file.");
            }
            
            if (signal.aborted) return;

            const totalChunks = audioChunks.length;
            const transcriptions: string[] = [];
            
            for (let i = 0; i < totalChunks; i++) {
                if (signal.aborted) break;

                const chunk = audioChunks[i];
                const chunkFile = new File([chunk], `chunk-${i + 1}.wav`, { type: 'audio/wav' });
                
                setStatusMessage(`Transcribing part ${i + 1} of ${totalChunks}...`);
                setProgress({ current: i + 1, total: totalChunks });

                const { mimeType, data } = await fileToBase64(chunkFile);
                const result = await callBackendAPI(data, mimeType);
                
                if (signal.aborted) break;

                transcriptions.push(result);
                setTranscription(transcriptions.join('\n\n---\n\n'));
            }
            
            if (!signal.aborted) setStatusMessage('Transcription complete!');
        }
    };

    const processBatchFiles = async (files: File[], signal: AbortSignal) => {
        const totalFiles = files.length;
        let cumulativeTranscription = "";

        for (let i = 0; i < totalFiles; i++) {
            if (signal.aborted) break;
            
            const file = files[i];
            const fileName = file.name;

            setStatusMessage(`Processing file ${i + 1} of ${totalFiles}: ${fileName}`);
            setProgress({ current: i + 1, total: totalFiles, detail: fileName });

            const { mimeType, data } = await fileToBase64(file);
            const result = await callBackendAPI(data, mimeType);

            if (signal.aborted) break;

            const formattedResult = `\n\n=== File: ${fileName} ===\n\n${result}`;
            cumulativeTranscription += formattedResult;
            
            setTranscription(cumulativeTranscription.trim());
        }

        if (!signal.aborted) setStatusMessage('Batch transcription complete!');
    };

    const handleCancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setIsLoading(false);
        setProgress(null);
        setStatusMessage('Transcription cancelled by user.');
    };
    
    const handleCopy = useCallback(() => {
        if (transcription) {
            navigator.clipboard.writeText(transcription);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [transcription]);

    const handleDownload = useCallback(() => {
        if (transcription) {
            const element = document.createElement("a");
            const file = new Blob([transcription], {type: 'text/plain'});
            element.href = URL.createObjectURL(file);
            element.download = `taglish_transcription_${new Date().toISOString().slice(0,10)}.txt`;
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
        }
    }, [transcription]);

    const resetState = () => {
      setAudioFile(null);
      setTranscription(null);
      setError(null);
      setIsLoading(false);
      setProgress(null);
      setStatusMessage('');
      setCopied(false);
    };

    // --- AUTH SCREEN RENDER ---
    if (!isAuthenticated) {
        return (
            <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 font-sans text-slate-200">
                <div className="bg-slate-800 rounded-xl shadow-2xl p-8 max-w-md w-full border border-slate-700 text-center">
                    <div className="bg-sky-900/30 p-4 rounded-full inline-flex items-center justify-center mb-6">
                        <LockIcon className="w-10 h-10 text-sky-400" />
                    </div>
                    <h1 className="text-2xl font-bold text-white mb-2">Taglish Transcriber Pro</h1>
                    <p className="text-slate-400 mb-6">Enter your access code to continue.</p>
                    
                    <form onSubmit={handleLogin} className="space-y-4">
                        <input
                            type="password"
                            value={accessCodeInput}
                            onChange={(e) => setAccessCodeInput(e.target.value)}
                            placeholder="Access Code"
                            className="w-full px-4 py-3 bg-slate-900 border border-slate-600 rounded-lg text-white placeholder-slate-500 focus:ring-2 focus:ring-sky-500 focus:border-transparent outline-none transition-all"
                        />
                        {authError && <p className="text-red-400 text-sm">{authError}</p>}
                        <button 
                            type="submit"
                            className="w-full py-3 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-colors"
                        >
                            Unlock App
                        </button>
                    </form>
                    <p className="mt-4 text-xs text-slate-500">Don't have a code? Contact the owner.</p>
                </div>
            </div>
        );
    }

    // --- MAIN APP RENDER ---
    return (
        <div className="min-h-screen bg-slate-900 text-slate-200 flex flex-col items-center justify-center p-4 font-sans">
            <div className="w-full max-w-3xl mx-auto">
                <header className="text-center mb-8">
                    <h1 className="text-4xl sm:text-5xl font-bold text-sky-400">Taglish Audio Transcriber</h1>
                    <p className="text-slate-400 mt-2">Professional Transcription with Timestamps</p>
                </header>

                <main className="bg-slate-800/50 backdrop-blur-sm rounded-xl shadow-2xl shadow-slate-950/50 p-6 sm:p-8 border border-slate-700">
                    
                    {!isLoading && (
                         <div className="mb-8 grid grid-cols-2 gap-4 bg-slate-900/50 p-2 rounded-lg">
                            <button 
                                onClick={() => handleModeChange('single')}
                                className={`py-3 px-4 rounded-md text-sm font-medium transition-all ${mode === 'single' ? 'bg-sky-600 text-white shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
                            >
                                Single File (Any Length)
                            </button>
                            <button 
                                onClick={() => handleModeChange('batch')}
                                className={`py-3 px-4 rounded-md text-sm font-medium transition-all ${mode === 'batch' ? 'bg-sky-600 text-white shadow-lg' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
                            >
                                Batch Upload (≤ 30 mins)
                            </button>
                         </div>
                    )}

                    {mode === 'single' && !isLoading && !audioFile && (
                        <div className="flex flex-col items-center justify-center animate-fade-in">
                             <p className="text-sm text-slate-400 mb-4 text-center">Suitable for long meetings (processed in 12-min chunks with overlap).</p>
                            <label htmlFor="audio-upload" className="w-full cursor-pointer p-10 border-2 border-dashed border-slate-600 rounded-lg text-center hover:border-sky-500 hover:bg-slate-700/50 transition-colors duration-300">
                                <UploadIcon className="w-12 h-12 mx-auto text-slate-500 mb-4" />
                                <span className="text-lg font-semibold text-slate-300">Upload Single File</span>
                                <p className="text-sm text-slate-400 mt-1">MP3, WAV, M4A, etc.</p>
                            </label>
                            <input id="audio-upload" type="file" accept="audio/*" className="hidden" onChange={handleSingleFileChange} />
                        </div>
                    )}

                    {mode === 'batch' && !isLoading && confirmedBatchCount === 0 && (
                        <div className="flex flex-col items-center justify-center animate-fade-in bg-slate-700/30 p-6 rounded-lg border border-slate-600/50">
                            <h3 className="text-lg font-semibold text-sky-400 mb-2">Multiple Files Upload</h3>
                            <p className="text-slate-300 mb-4 text-center text-sm">
                                Only use this for files that are <strong>30 minutes or less</strong>.
                            </p>
                            <label className="block text-sm font-medium text-slate-400 mb-2">How many files do you want to upload? (Max 15)</label>
                            <div className="flex gap-2 w-full max-w-xs">
                                <input 
                                    type="number" 
                                    min="1" 
                                    max="15"
                                    value={fileCountInput}
                                    onChange={(e) => setFileCountInput(e.target.value)}
                                    className="block w-full rounded-md border-slate-600 bg-slate-800 text-white shadow-sm focus:border-sky-500 focus:ring-sky-500 sm:text-sm p-2.5"
                                    placeholder="#"
                                />
                                <button 
                                    onClick={handleSetFileCount}
                                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-sky-600 hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-500"
                                >
                                    Set
                                </button>
                            </div>
                        </div>
                    )}

                    {mode === 'batch' && !isLoading && confirmedBatchCount > 0 && (
                        <div className="space-y-3 animate-fade-in">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-md font-semibold text-slate-200">Upload {confirmedBatchCount} Files</h3>
                                <button onClick={() => { setConfirmedBatchCount(0); setBatchFiles([]); }} className="text-xs text-red-400 hover:text-red-300 underline">Reset</button>
                            </div>
                            <div className="grid grid-cols-1 gap-3 max-h-[300px] overflow-y-auto pr-2">
                                {Array.from({ length: confirmedBatchCount }).map((_, idx) => (
                                    <div key={idx} className="flex items-center gap-3 bg-slate-700/30 p-3 rounded border border-slate-600/50">
                                        <span className="text-slate-400 font-mono text-sm w-6">#{idx + 1}</span>
                                        {batchFiles[idx] ? (
                                             <div className="flex-1 flex items-center gap-2 overflow-hidden">
                                                <AudioFileIcon className="w-5 h-5 text-sky-400 flex-shrink-0" />
                                                <span className="text-sm text-slate-200 truncate">{batchFiles[idx]?.name}</span>
                                             </div>
                                        ) : (
                                            <input 
                                                type="file" 
                                                accept="audio/*"
                                                className="block w-full text-sm text-slate-400 file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-sky-900 file:text-sky-300 hover:file:bg-sky-800"
                                                onChange={(e) => handleBatchFileChange(idx, e)}
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {mode === 'single' && audioFile && (
                        <div className="mb-6 flex items-center gap-4 bg-slate-700/50 p-4 rounded-lg border border-slate-600/50">
                            <AudioFileIcon className="w-10 h-10 text-sky-400 flex-shrink-0" />
                            <div className="overflow-hidden">
                                <p className="font-semibold text-slate-200 truncate">{audioFile.name}</p>
                                <p className="text-sm text-slate-400">{(audioFile.size / 1024 / 1024).toFixed(2)} MB</p>
                            </div>
                            {!isLoading && (
                                <button onClick={resetState} className="ml-auto text-sm text-red-400 hover:text-red-300">Remove</button>
                            )}
                        </div>
                    )}

                    {( (mode === 'single' && audioFile) || (mode === 'batch' && confirmedBatchCount > 0) ) && (
                        <div className="space-y-6 mt-6">
                            <div className="bg-slate-700/30 p-4 rounded-lg border border-slate-600/30">
                                <label htmlFor="speaker-names" className="block text-sm font-medium text-slate-300 mb-2">
                                    Meeting Participants / Speakers
                                </label>
                                <textarea
                                    id="speaker-names"
                                    rows={2}
                                    className="w-full bg-slate-800 border border-slate-600 rounded-md p-2.5 text-sm text-white focus:ring-sky-500 focus:border-sky-500 placeholder-slate-500"
                                    placeholder="E.g. Juan dela Cruz (Chair), Maria Santos, Pedro..."
                                    value={speakerNames}
                                    onChange={(e) => setSpeakerNames(e.target.value)}
                                    disabled={isLoading}
                                />
                                <p className="mt-1 text-xs text-slate-400">
                                    Providing names helps the AI identify who is speaking.
                                </p>
                            </div>

                            <div className="flex flex-col sm:flex-row gap-4">
                                {!isLoading ? (
                                    <button
                                        onClick={handleTranscribe}
                                        className="w-full justify-center inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-sky-600 hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-sky-500 transition-colors"
                                    >
                                        {mode === 'single' ? 'Start Transcription' : 'Start Batch Transcription'}
                                    </button>
                                ) : (
                                    <button
                                        onClick={handleCancel}
                                        className="w-full justify-center inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-red-500 transition-colors gap-2"
                                    >
                                        <CancelIcon className="w-5 h-5" />
                                        Cancel Transcription
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                    
                    {isLoading && (
                        <div className="mt-6 text-center text-slate-400 flex flex-col items-center">
                            <SpinnerIcon className="w-8 h-8 animate-spin text-sky-500" />
                            <p className="mt-2 font-medium">{statusMessage}</p>
                            {progress && (
                                <div className="w-full mt-3">
                                    <div className="w-full bg-slate-700 rounded-full h-2.5">
                                        <div 
                                            className="bg-sky-600 h-2.5 rounded-full transition-all duration-300" 
                                            style={{ width: `${(progress.current / progress.total) * 100}%` }}>
                                        </div>
                                    </div>
                                    <p className="text-xs mt-1 text-slate-500">
                                        Processing {progress.current} of {progress.total} {progress.detail ? `(${progress.detail})` : ''}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {error && (
                        <div className="mt-6 p-4 bg-red-900/50 border border-red-700 rounded-lg flex items-center gap-3 animate-fade-in">
                            <ErrorIcon className="w-6 h-6 text-red-400 flex-shrink-0" />
                            <div>
                              <p className="font-semibold text-red-400">Error</p>
                              <p className="text-red-300 text-sm">{error}</p>
                            </div>
                        </div>
                    )}

                    {transcription && (
                        <div className="mt-6 space-y-4 animate-fade-in">
                            <div className="flex flex-wrap gap-2 justify-between items-center">
                                <h2 className="text-2xl font-bold text-slate-100">Transcription Result</h2>
                                <div className="flex gap-2">
                                    <button onClick={handleCopy} className="inline-flex items-center gap-2 px-3 py-1.5 border border-slate-600 text-sm font-medium rounded-md text-slate-300 hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-slate-500 transition-all">
                                        {copied ? <CheckIcon className="w-4 h-4 text-green-400" /> : <CopyIcon className="w-4 h-4" />}
                                        {copied ? 'Copied!' : 'Copy'}
                                    </button>
                                    <button onClick={handleDownload} className="inline-flex items-center gap-2 px-3 py-1.5 border border-slate-600 text-sm font-medium rounded-md text-sky-300 hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-800 focus:ring-sky-500 transition-all">
                                        <DownloadIcon className="w-4 h-4" />
                                        Download .txt
                                    </button>
                                </div>
                            </div>
                            <div className="bg-slate-900/70 p-4 rounded-lg max-h-[500px] overflow-y-auto border border-slate-700 text-sm sm:text-base">
                                <p className="text-slate-300 whitespace-pre-wrap leading-relaxed font-mono">{transcription}</p>
                            </div>
                        </div>
                    )}

                    <div className="mt-8 pt-6 border-t border-slate-700/50">
                        <p className="text-xs text-slate-500 text-center italic">
                            <strong>Disclaimer:</strong> Automated transcription is subject to error. 
                            Users must review and verify the accuracy of the transcription compared to the original audio recording.
                            Processing is done in secure chunks with overlap to ensure continuity.
                        </p>
                    </div>
                </main>
            </div>
        </div>
    );
}
