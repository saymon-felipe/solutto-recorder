export class RenderManager {
    constructor(studio) {
        this.studio = studio;
        this.isRendering = false;
        this.abortController = null;
        
        // Estatísticas
        this.renderStartTime = 0;
        this.framesProcessed = 0;
    }

    init() {
        const btnRender = document.getElementById("btn-studio-render");
        if(btnRender) btnRender.onclick = () => this._openRenderModal();
    }

    verifyIfTheProjectIsEmpty() {
        let empty = true;

        this.studio.project.tracks.forEach(track => {
            if (track.clips.length > 0) {
                empty = false;
            }
        })

        return empty;
    }

    _openRenderModal() {
        const modal = document.getElementById("render-modal");
        if (!modal) return;

        const empty = this.verifyIfTheProjectIsEmpty();
        if (empty) return;
        
        const resInput = document.getElementById("render-resolution");
        const projectW = this.studio.project.settings.width;
        const projectH = this.studio.project.settings.height;
        
        if (resInput) {
            resInput.innerHTML = `<option value="project" selected>${projectW}x${projectH}px</option>`;
            
            resInput.disabled = true; 
        }

        modal.classList.remove('hidden');
        
        const btnCancel = document.getElementById("btn-render-cancel");
        const newCancel = btnCancel.cloneNode(true);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
        
        const btnConfirm = document.getElementById("btn-render-confirm");
        const newConfirm = btnConfirm.cloneNode(true);
        btnConfirm.parentNode.replaceChild(newConfirm, btnConfirm);

        newCancel.onclick = () => modal.classList.add('hidden');
        
        newConfirm.onclick = () => {
            modal.classList.add('hidden');
            const fmtInput = document.getElementById("render-format");
            const qualInput = document.getElementById("render-quality");

            const options = {
                width: projectW,
                height: projectH,
                format: (fmtInput && fmtInput.value) ? fmtInput.value : 'webm',
                quality: (qualInput && qualInput.value) ? qualInput.value : 'medium'
            };
            
            this.renderProject(options);
        };
    }

    _getProjectEndTime() {
        let maxTime = 0;
        this.studio.project.tracks.forEach(track => {
            track.clips.forEach(clip => {
                const end = clip.start + clip.duration;
                if (end > maxTime) maxTime = end;
            });
        });
        return maxTime > 0 ? maxTime : 1;
    }

    async renderProject(options) {
        if (this.isRendering) return;

        this.isRendering = true;
        this.abortController = new AbortController();

        // Reset Stats
        this.renderStartTime = Date.now();
        this.framesProcessed = 0;

        const overlay = document.getElementById('render-progress-overlay');
        if (overlay) overlay.classList.remove('hidden');
        
        const btnAbort = document.getElementById('btn-render-abort');
        if (btnAbort) {
            btnAbort.onclick = () => {
                if (confirm("Deseja realmente cancelar a renderização?")) {
                    this.abortController.abort();
                }
            };
        }

        this._updateProgress(0, "Inicializando motor de renderização...");

        if(this.studio.playbackManager) this.studio.playbackManager.pause();

        let logHandler = null; 

        try {
            const transcoder = this.studio.editor.transcoder;
            if (!transcoder.isLoaded) {
                if(typeof transcoder.load === 'function') await transcoder.load();
                else await transcoder.init();
            }
            const ffmpeg = transcoder.ffmpeg;

            const width = options.width;
            const height = options.height;
            const fps = 30;
            const duration = this._getProjectEndTime();
            const totalFrames = Math.ceil(duration * fps);
            
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { alpha: false });

            console.log(`[Render] Início: ${width}x${height} @ ${fps}fps. Qualidade: ${options.quality}`);

            // 1. Áudio
            this._updateProgress(1, "Renderizando Áudio Master...");
            const audioBlob = await this._renderMasterAudio(duration);
            const audioFilename = "master.wav";
            await ffmpeg.writeFile(audioFilename, await this._fetchFile(audioBlob));

            // 2. Loop de Vídeo
            let videoChunks = [];
            let frameBuffer = [];
            const BATCH_SIZE = 30; 
            const originalTime = this.studio.project.currentTime;

            for (let i = 0; i < totalFrames; i++) {
                if (this.abortController.signal.aborted) throw new Error("Renderização cancelada pelo usuário.");

                const time = i / fps;
                if (i % 15 === 0) await new Promise(r => setTimeout(r, 0));

                let blob = await this.studio.playbackManager.renderFrameOffline(time, ctx, width, height);
                if (!blob) continue;

                const relativeIndex = frameBuffer.length; 
                const frameName = `img_${relativeIndex.toString().padStart(3, '0')}.jpg`;
                
                let buf = await blob.arrayBuffer();
                await ffmpeg.writeFile(frameName, new Uint8Array(buf));
                blob = null; buf = null;
                
                frameBuffer.push(frameName);
                this.framesProcessed++;

                const framePct = (this.framesProcessed / totalFrames) * 80;
                this._updateProgress(framePct, `Processando frame ${i}/${totalFrames}`, null);

                if (frameBuffer.length >= BATCH_SIZE || i === totalFrames - 1) {
                    if (frameBuffer.length === 0) continue;

                    const chunkName = `chunk_${videoChunks.length}.mp4`;
                    
                    // Gera chunk intermediário rápido (sempre ultrafast para agilidade nesta etapa)
                    await ffmpeg.exec([
                        "-framerate", `${fps}`,
                        "-start_number", "0",
                        "-i", "img_%03d.jpg",
                        "-frames:v", `${frameBuffer.length}`,
                        "-c:v", "libx264",
                        "-preset", "ultrafast",
                        "-pix_fmt", "yuv420p",
                        chunkName
                    ]);

                    videoChunks.push(chunkName);

                    for (const f of frameBuffer) { try { await ffmpeg.deleteFile(f); } catch(e){} }
                    frameBuffer = [];
                }
            }

            this._updateProgress(80, "Unindo segmentos...");
            const listName = "chunks.txt";
            const listContent = videoChunks.map(c => `file '${c}'`).join('\n');
            await ffmpeg.writeFile(listName, new TextEncoder().encode(listContent));

            const videoOnlyName = "video_silent.mp4";
            await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", listName, "-c", "copy", videoOnlyName]);

            await this._cleanupFS(ffmpeg, [...videoChunks, listName]);
            videoChunks = [];

            logHandler = ({ message }) => {
                const timeMatch = typeof message === 'string' ? message.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/) : null;
                if (timeMatch) {
                    const tStr = timeMatch[1];
                    const [h, m, s] = tStr.split(':');
                    const processedSeconds = (parseInt(h) * 3600) + (parseInt(m) * 60) + parseFloat(s);
                    const encodePct = Math.min(1, processedSeconds / duration);
                    const globalPct = 80 + (encodePct * 20);
                    this._updateProgress(globalPct, "Finalizando (Encoding)...");
                }
            };
            ffmpeg.on("log", logHandler);

            const outputName = `final.${options.format}`;
            const outputArgs = []; 

            if (options.format === 'webm') {
                // Codec VP8/VP9
                outputArgs.push("-c:v", "libvpx", "-c:a", "libvorbis");
                
                if (options.quality === 'low') {
                    outputArgs.push("-b:v", "500k", "-crf", "35"); // Rápido, leve, baixa qualidade
                } else if (options.quality === 'high') {
                    outputArgs.push("-b:v", "3M", "-crf", "4");    // Alta qualidade, pesado
                } else {
                    outputArgs.push("-b:v", "1M", "-crf", "10");   // Médio (Padrão)
                }
            } else {                 
                outputArgs.push("-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p");

                if (options.quality === 'low') {
                    // Baixa qualidade, muito rápido
                    outputArgs.push("-preset", "ultrafast", "-crf", "28"); 
                } else if (options.quality === 'high') {
                    // Alta qualidade, mais lento
                    outputArgs.push("-preset", "medium", "-crf", "18"); 
                } else {
                    // Média (Equilíbrio)
                    outputArgs.push("-preset", "veryfast", "-crf", "23"); 
                }
            }

            await ffmpeg.exec([
                "-i", videoOnlyName,
                "-i", audioFilename,
                "-map", "0:v:0", 
                "-map", "1:a:0",
                "-shortest",
                ...outputArgs,
                outputName
            ]);

            ffmpeg.off("log", logHandler);
            logHandler = null;

            await this._cleanupFS(ffmpeg, [videoOnlyName, audioFilename]);

            // 5. Resultado
            const data = await ffmpeg.readFile(outputName);
            const finalBlob = new Blob([data.buffer], { type: `video/${options.format}` });

            try { await ffmpeg.deleteFile(outputName); } catch(e){}
            
            this.studio.project.currentTime = originalTime;
            this.studio.playbackManager.syncPreview();

            this._updateProgress(100, "Concluído!", "Finalizado");
            
            this.studio.editor.videoBlob = finalBlob;
            
            if (typeof this.studio.editor._generateFileName === 'function') {
                this.studio.editor.fileName = `${this.studio.editor._generateFileName()}_rendered`;
            } else {
                this.studio.editor.fileName = `render_${Date.now()}`;
            }

            this.studio.editor.currentExtension = options.format; 
            
            const url = URL.createObjectURL(finalBlob);
            await this.studio.editor._loadVideo(url);
            
            if (options.format === 'mp4') {
                const sig = `0.00_${duration.toFixed(2)}_${finalBlob.size}`;
                this.studio.editor.cachedMp4 = { blob: finalBlob, signature: sig };
            }

            if (this.studio.editor.ui && this.studio.editor.ui.video) {
                this.studio.editor.ui.video.pause(); 
            }

            this.studio.playbackManager.stop();
            if (this.studio.playbackManager.toggleMonitorMute) {
                this.studio.playbackManager.toggleMonitorMute(false);
            }

            this.isRendering = false;
            this.studio.editor._enableButtons();
            this.studio.toggleMode();

        } catch (error) {
            console.error("Render Error:", error);

            if (logHandler) {
                try { 
                    const transcoder = this.studio.editor.transcoder;
                    if(transcoder && transcoder.ffmpeg) transcoder.ffmpeg.off("log", logHandler);
                } catch(e){}
            }
            if (error.message !== "Renderização cancelada pelo usuário.") {
                alert("Erro: " + error.message);
            }
        } finally {
            this.isRendering = false;
            if (btnAbort) btnAbort.onclick = null;

            if(overlay) overlay.classList.add('hidden');
            const btn = document.getElementById("btn-studio-render");
            if(btn) btn.disabled = false;
        }
    }

    async _renderMasterAudio(duration) {
        const sampleRate = 44100;
        const safeDur = Math.max(0.1, duration);
        const offlineCtx = new OfflineAudioContext(2, sampleRate * safeDur, sampleRate);
        
        for (const track of this.studio.project.tracks) {
            if (track.muted) continue;
            for (const clip of track.clips) {
                const asset = this.studio.assetManager.getAsset(clip.assetId);
                if (!asset) continue;

                let buffer = asset.audioBuffer; 
                if (!buffer && asset.sourceBlob) {
                    try {
                        const ab = await asset.sourceBlob.arrayBuffer();
                        buffer = await offlineCtx.decodeAudioData(ab);
                        asset.audioBuffer = buffer; 
                    } catch(e) {}
                }

                if (buffer) {
                    const src = offlineCtx.createBufferSource();
                    src.buffer = buffer;
                    const gain = offlineCtx.createGain();
                    
                    // Volume Base
                    const baseVol = (clip.volume || 1) * (clip.level !== undefined ? clip.level : 1);
                    
                    const fadeIn = Number(clip.fadeIn) || 0;
                    const fadeOut = Number(clip.fadeOut) || 0;
                    const startTime = clip.start;
                    const endTime = clip.start + clip.duration;

                    // Lógica de Fade In
                    if (fadeIn > 0) {
                        gain.gain.setValueAtTime(0, startTime);
                        gain.gain.linearRampToValueAtTime(baseVol, startTime + fadeIn);
                    } else {
                        gain.gain.setValueAtTime(baseVol, startTime);
                    }

                    // Lógica de Fade Out
                    if (fadeOut > 0) {
                        const fadeOutStart = Math.max(startTime + fadeIn, endTime - fadeOut);
                        
                        gain.gain.setValueAtTime(baseVol, fadeOutStart);
                        gain.gain.linearRampToValueAtTime(0, endTime);
                    }

                    src.connect(gain);
                    gain.connect(offlineCtx.destination);
                    try { src.start(clip.start, clip.offset, clip.duration); } catch(e){}
                }
            }
        }
        const rendered = await offlineCtx.startRendering();
        return this._bufferToWave(rendered, rendered.length);
    }

    /**
     * Atualiza a UI com cálculos de tempo baseados na porcentagem GLOBAL (0-100).
     * @param {number} pct - Porcentagem Global (0 a 100)
     * @param {string} statusText - Texto de status
     * @param {string|null} speedOverride - Texto de velocidade opcional (para fase 2)
     */
    _updateProgress(pct, statusText, speedOverride = null) {
        const overlay = document.getElementById('render-progress-overlay');
        const elPercentage = document.getElementById('render-percentage-text');
        const elElapsed = document.getElementById('render-timer-elapsed');
        const elRemaining = document.getElementById('render-timer-left');
        const elSpeed = document.getElementById('render-speed-text');
        const elLog = document.getElementById('render-log-text');
        
        let elBar = null;
        if(overlay) elBar = overlay.querySelector('.vegas-progress-fill');

        // Clamp
        pct = Math.max(0, Math.min(100, pct));

        if(elBar) elBar.style.width = `${pct}%`;
        if(elPercentage) elPercentage.innerText = `${Math.floor(pct)}%`;
        if(elLog) elLog.innerText = statusText;

        if (this.renderStartTime > 0) {
            const now = Date.now();
            const elapsedSeconds = (now - this.renderStartTime) / 1000;
            
            // Atualiza Tempo Decorrido
            if (elElapsed) elElapsed.innerText = this._fmt(elapsedSeconds);

            // Atualiza Tempo Restante (Estimativa Linear baseada no progresso global)
            // Se pct < 1, evita divisão por zero ou números gigantes
            if (pct > 1 && pct < 100) {
                const totalEstimatedSeconds = (elapsedSeconds / pct) * 100;
                const remainingSeconds = Math.max(0, totalEstimatedSeconds - elapsedSeconds);
                if (elRemaining) elRemaining.innerText = `${this._fmt(remainingSeconds)}`;
            } else if (pct >= 100) {
                if (elRemaining) elRemaining.innerText = "Finalizado";
            } else {
                if (elRemaining) elRemaining.innerText = "Calculando...";
            }

            // Atualiza Velocidade
            if (elSpeed) {
                if (speedOverride) {
                    elSpeed.innerText = speedOverride;
                } else if (pct > 0 && pct <= 80) {
                    // Fase 1: Baseada em FPS
                    const fps = this.framesProcessed / elapsedSeconds;
                    const speedX = fps / 30; // Assumindo base 30fps
                    elSpeed.innerText = `${speedX.toFixed(1)}x (${Math.floor(fps)} fps)`;
                }
            }
        }
    }

    _fmt(s) {
        if (!Number.isFinite(s) || s < 0) return "00:00:00";
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    async _fetchFile(data) {
        if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
        return data;
    }

    async _cleanupFS(ffmpeg, files) {
        for (const f of files) {
            try { await ffmpeg.deleteFile(f); } catch(e){}
        }
    }

    _bufferToWave(abuffer, len) {
        let numOfChan = abuffer.numberOfChannels,
            length = len * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels = [], i, sample,
            offset = 0, pos = 0;

        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); 
        setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
        setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan);
        setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); 
        setUint32(length - pos - 4);

        for(i = 0; i < numOfChan; i++) channels.push(abuffer.getChannelData(i));

        while(pos < len) {
            for(i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][pos]));
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0;
                view.setInt16(44 + offset, sample, true);
                offset += 2;
            }
            pos++;
        }
        return new Blob([buffer], {type: "audio/wav"});

        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
    }
}