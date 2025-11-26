/**
 * RecorderManager - Gerenciador de Gravação.
 * ATUALIZADO: Fluxo reordenado (UI -> Webcam -> Countdown -> REC) e Segmentos.
 */
(function () {
    const C = window.SoluttoConstants;
    const UI = window.SoluttoUIManager;

    class RecorderManager {
        constructor() {
            this.mediaRecorder = null;
            this.stream = null;
            this.status = "idle"; 
            this.elapsedSeconds = 0;
            this.timerInterval = null;
            this.recordingType = null;
            this.onStopCallback = null;
            
            this.currentVideoId = null;
            this.chunkIndex = 0;
            this.currentSegment = 0;
            this.sessionOptions = null; 

            this.ui = UI.getInstance();
            this.onUserActionCallback = null;

            window.addEventListener('beforeunload', () => {
                if (this.status !== 'idle') this._saveSessionState();
            });
        }

        recoverState(videoId, elapsedSeconds, recordingType, options) {
            console.log(`[Recorder] RecoverState: ID=${videoId}, Tempo=${elapsedSeconds}`);
            this.currentVideoId = videoId;
            this.elapsedSeconds = typeof elapsedSeconds === 'number' ? elapsedSeconds : 0;
            this.recordingType = recordingType;
            this.sessionOptions = options || {};
            this.status = "paused"; 
            
            this._syncResumeInfo();
        }

        async _syncResumeInfo() {
             if (!this.currentVideoId) return;
             try {
                 const info = await chrome.runtime.sendMessage({ 
                     action: "get_resume_info", 
                     videoId: this.currentVideoId 
                 });
                 
                 this.chunkIndex = info.count || 0;
                 this.currentSegment = info.lastSegment || 0;
                 
                 console.log(`[Recorder] Sync: Chunks=${this.chunkIndex}, LastSegment=${this.currentSegment}`);
             } catch (e) {
                 console.error("[Recorder] Erro sync:", e);
             }
        }

        /**
         * Inicia gravação.
         * @param {Function} onUIReadyCallback - Chamado após a UI montar, mas ANTES do countdown. Usado para injetar webcam.
         */
        async start(stream, options, onStopCallback = null, onUIReadyCallback = null, existingVideoId = null) {
            if (this.status === "recording") return;

            this.stream = stream;
            this.sessionOptions = options; 
            this.recordingType = options.type || "screen";
            this.onStopCallback = onStopCallback; 
            
            const timeoutSeconds = parseInt(options.timeout || 0);

            if (existingVideoId) {
                // --- RESUME ---
                this.currentVideoId = existingVideoId;
                await this._syncResumeInfo();
                this.currentSegment++;
                console.log(`[Recorder] Novo Segmento: ${this.currentSegment}`);
            } else {
                // --- NEW ---
                this.currentVideoId = "vid_" + Date.now();
                this.chunkIndex = 0;
                this.currentSegment = 0;
                this.elapsedSeconds = 0;
            }

            this._saveSessionState();

            const mediaOptions = this._getRecorderOptions();
            try {
                this.mediaRecorder = new MediaRecorder(stream, mediaOptions);
            } catch (e) {
                console.warn("Falha codec preferido:", e);
                this.mediaRecorder = new MediaRecorder(stream);
            }

            this.mediaRecorder.ondataavailable = async (e) => {
                if (e.data && e.data.size > 0) {
                    await this._persistChunk(e.data);
                }
            };

            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.onended = () => {
                    if (this.status !== "idle") this.stop();
                };
            }

            await this.ui.showControls((action) => this._handleUserAction(action));

            if (onUIReadyCallback) {
                await onUIReadyCallback();
            }

            if (timeoutSeconds > 0 && !existingVideoId) {
                await this.ui.showCountdown(timeoutSeconds);
            }

            // 4. INICIA GRAVAÇÃO
            this.mediaRecorder.start(C.RECORDER.TIMESLICE_MS);
            this.status = "recording";
            
            this._startTimer(!existingVideoId);
            
            chrome.runtime.sendMessage({ action: C.ACTIONS.CHANGE_ICON, type: "recording" });
            
            // Garante visual atualizado
            this.ui.updateTimer(this.elapsedSeconds);
            if (existingVideoId) {
                this.ui.togglePauseState(false);
            }
        }

        async _persistChunk(blob) {
            try {
                const buffer = await blob.arrayBuffer();
                const dataArray = Array.from(new Uint8Array(buffer));
                
                const indexToSend = this.chunkIndex++;
                
                chrome.runtime.sendMessage({
                    action: "save_chunk",
                    videoId: this.currentVideoId,
                    index: indexToSend,
                    segment: this.currentSegment,
                    data: dataArray
                });
            } catch (error) {
                console.error("Erro ao persistir chunk:", error);
            }
        }

        pause() {
            if (this.status === "recording" && this.mediaRecorder.state === "recording") {
                this.mediaRecorder.pause();
                this.status = "paused";
                this._stopTimer(false);
                this.ui.togglePauseState(true);
                this._saveSessionState();
            }
        }

        resume() {
            if (this.status === "paused" && this.mediaRecorder && this.mediaRecorder.state === "paused") {
                this.mediaRecorder.resume();
                this.status = "recording";
                this._startTimer(false);
                this.ui.togglePauseState(false);
            }
        }

        async stop() {
            if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
                this.mediaRecorder.stop();
            }
            
            this._stopTimer();
            this._clearSessionState();
            
            await new Promise(r => setTimeout(r, 800));

            chrome.runtime.sendMessage({
                action: "finish_video",
                videoId: this.currentVideoId
            });

            this._cleanup();
        }

        cancel() {
            if (this.mediaRecorder) {
                this.mediaRecorder.onstop = null;
                this.mediaRecorder.stop();
            }
            this._clearSessionState();
            this._cleanup();
        }

        _handleUserAction(action) {
            if (this.onUserActionCallback) {
                this.onUserActionCallback(action);
                return;
            }
            switch (action) {
                case C.ACTIONS.STOP_RECORDING: this.stop(); break;
                case "pause": this.pause(); break;
                case "resume": this.resume(); break;
                case C.ACTIONS.CANCEL_RECORDING: this.cancel(); break;
            }
        }
        
        bindActionHandler(callback) {
            this.onUserActionCallback = callback;
        }

        _cleanup() {
            this._stopTimer();
            this.ui.cleanup();
            if (this.stream) this.stream.getTracks().forEach(track => track.stop());
            if (this.onStopCallback) this.onStopCallback();
            
            this.mediaRecorder = null;
            this.stream = null;
            this.status = "idle";
            this.onUserActionCallback = null;
            this.sessionOptions = null;
            chrome.runtime.sendMessage({ action: C.ACTIONS.CHANGE_ICON, type: "default" });
        }

        _startTimer(shouldReset = true) {
            this._stopTimer(shouldReset);
            this.timerInterval = setInterval(() => {
                this.elapsedSeconds++;
                this.ui.updateTimer(this.elapsedSeconds);
                this._saveSessionState(); 
            }, 1000);
        }

        _stopTimer(reset = true) {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            if (reset) this.elapsedSeconds = 0;
        }

        _getRecorderOptions() {
            for (const mimeType of C.RECORDER.MIME_TYPE_PREFERENCE) {
                if (MediaRecorder.isTypeSupported(mimeType)) {
                    return { mimeType: mimeType, videoBitsPerSecond: C.RECORDER.VIDEO_BITS_PER_SECOND };
                }
            }
            return {};
        }

        _saveSessionState() {
            if (!this.currentVideoId) return;
            const state = {
                videoId: this.currentVideoId,
                status: this.status,
                elapsedSeconds: this.elapsedSeconds,
                recordingType: this.recordingType,
                timestamp: Date.now(),
                options: this.sessionOptions
            };
            sessionStorage.setItem('solutto_rec_state', JSON.stringify(state));
        }

        _clearSessionState() {
            sessionStorage.removeItem('solutto_rec_state');
        }
    }

    window.SoluttoRecorderManager = RecorderManager;
})();