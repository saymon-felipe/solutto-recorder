export class RenderManager {
    constructor(studio) {
        this.studio = studio;
        this.isRendering = false;
        this.renderStartTime = 0;
        this.recorder = null;
        this.chunks = [];
        this.renderOptions = {};
        
        // Constantes de UX
        this.RECORDING_WEIGHT = 0.8; // 80% para gravação
        this.CONVERSION_WEIGHT = 0.2; // 20% para conversão
    }

    init() {
        const btnRender = document.getElementById("btn-studio-render");
        if(btnRender) btnRender.onclick = () => this._openRenderModal();
    }

    _openRenderModal() {
        const modal = document.getElementById("render-modal");
        if (!modal) return;
        modal.classList.remove('hidden');
        
        document.getElementById("btn-render-cancel").onclick = () => modal.classList.add('hidden');
        
        document.getElementById("btn-render-confirm").onclick = () => {
            modal.classList.add('hidden');
            const formatInput = document.getElementById("render-format");
            const options = {
                resolution: document.getElementById("render-resolution").value,
                quality: document.getElementById("render-quality").value,
                format: formatInput ? formatInput.value : 'mp4'
            };
            this.renderProject(options);
        };

        const btnAbort = document.getElementById("btn-render-abort");
        if (btnAbort) btnAbort.onclick = () => this.cancelRendering();

        const resSelect = document.getElementById("render-resolution");
        if(resSelect) {
            const { width, height } = this.studio.project.settings;
            resSelect.innerHTML = `<option value="project" selected>Projeto (${width}x${height})</option>`;
            resSelect.disabled = true;
        }
    }

    async renderProject(options) {
        if (this.isRendering) return;

        this.renderOptions = options; 
        this._showProgressOverlay();
        this.isRendering = true;
        this.renderStartTime = Date.now();
        this.chunks = [];

        const project = this.studio.project;
        const playback = this.studio.playbackManager;

        // 1. Calcula Duração
        let maxDuration = 0;
        project.tracks.forEach(track => {
            track.clips.forEach(clip => {
                const clipEnd = clip.start + clip.duration;
                if (clipEnd > maxDuration) maxDuration = clipEnd;
            });
        });
        const renderDuration = maxDuration > 0 ? maxDuration : 5;
        const totalFrames = Math.ceil(renderDuration * 30);

        try {
            playback.stop();
            await new Promise(r => setTimeout(r, 200)); 
            
            await playback.seekAndRender(0);

            const stream = playback.getCompositeStream(30);

            // Muta monitoramento
            if (playback.toggleMonitorMute) playback.toggleMonitorMute(true);

            if (stream.getAudioTracks().length === 0) {
                console.warn("[Render] Atenção: Stream sem áudio.");
            }

            // --- CORREÇÃO DE PERFORMANCE ---
            // NUNCA tente gravar em 'video/mp4' nativamente. O Encoder H.264 do Chrome 
            // engasga em tempo real com Canvas, causando travamentos.
            // Gravamos SEMPRE em WebM (VP9/VP8) que é leve e fluido, 
            // e deixamos a conversão para MP4 ocorrer no pós-processamento (_finishRender).
            
            let mimeType = 'video/webm;codecs=vp9,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp8,opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

            const optionsRec = {
                mimeType: mimeType,
                videoBitsPerSecond: 8000000 // 8 Mbps
            };

            console.log(`[Render] Gravando internamente em: ${mimeType} (Para estabilidade)`);
            this.recorder = new MediaRecorder(stream, optionsRec);

            this.recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) this.chunks.push(e.data);
            };

            // 5. Inicia
            this.recorder.start();
            playback.play(); 

            // 6. Loop de Monitoramento
            const checkInterval = setInterval(() => {
                const current = project.currentTime;
                
                // Progresso Visual (Se MP4, vai até 80%, senão 100%)
                const maxVisualPct = (this.renderOptions.format === 'mp4') ? 0.8 : 1.0;
                
                const rawPct = Math.min(1, current / renderDuration);
                const visualPct = rawPct * maxVisualPct;

                const currentFrame = Math.min(totalFrames, Math.floor(current * 30));
                
                this.updateProgress(
                    visualPct, 
                    `Frames: ${currentFrame} / ${totalFrames}`, 
                    Math.max(0, renderDuration - current), 
                    (Date.now() - this.renderStartTime) / 1000
                );

                if (current >= renderDuration || !this.isRendering) {
                    this._finishRender(checkInterval, mimeType, renderDuration);
                }
            }, 30);

        } catch (e) {
            console.error(e);
            alert("Erro ao renderizar: " + e.message);
            this.cancelRendering();
        }
    }

    async _finishRender(intervalId, recordedMimeType, duration) {
        clearInterval(intervalId);
        
        // 1. Pausa a reprodução (Não use stop() aqui para evitar que pule para o início e toque áudio)
        this.studio.playbackManager.pause();
        
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.stop();
        }

        // NÃO DESMUTE AQUI AINDA. Espere a conversão acabar.

        // Se for WebM (sem conversão), já pula para 100%
        if (this.renderOptions.format !== 'mp4') {
            this.updateProgress(1, "Finalizando...", 0, (Date.now() - this.renderStartTime)/1000);
        }

        setTimeout(async () => {
            let finalBlob = new Blob(this.chunks, { type: recordedMimeType });
            let finalExt = 'webm';

            // --- FASE 2: CONVERSÃO MP4 ---
            if (this.renderOptions.format === 'mp4') {
                // Ticker para manter o relógio rodando durante a conversão
                const conversionTicker = setInterval(() => {
                    // Apenas atualiza o tempo decorrido, mantendo os textos atuais
                    const overlay = document.getElementById('render-progress-overlay');
                    if (overlay && !overlay.classList.contains('hidden')) {
                        const elapsed = (Date.now() - this.renderStartTime) / 1000;
                        const el = document.getElementById('render-timer-elapsed');
                        if(el) el.innerText = this._fmt(elapsed);
                    }
                }, 1000);

                try {
                    const elLog = document.getElementById('render-speed-text');
                    if(elLog) elLog.innerText = "Iniciando conversor...";
                    
                    const onConvertProgress = (info) => {
                        const startPct = 0.8; 
                        const range = 0.19; // Vai até 99%
                        const totalPct = startPct + (info.percent * range);
                        
                        let estimatedRem = 0;
                        if (info.speed > 0) {
                            estimatedRem = (duration - info.secondsProcessed) / info.speed;
                        }

                        this.updateProgress(
                            totalPct,
                            `Convertendo: ${info.speed.toFixed(2)}x`, 
                            Math.max(0, estimatedRem),
                            (Date.now() - this.renderStartTime) / 1000 
                        );
                    };

                    const mp4Url = await this.studio.editor.transcoder.processVideo(
                        finalBlob, "render", 0, duration, 'mp4', {}, onConvertProgress
                    );
                    
                    const res = await fetch(mp4Url);
                    finalBlob = await res.blob();
                    finalExt = 'mp4';
                    
                } catch (e) {
                    console.error("Erro MP4:", e);
                    alert("Conversão falhou. Salvando como WebM.");
                } finally {
                    clearInterval(conversionTicker);
                }
            }

            // --- FINALIZAÇÃO ---
            this.studio.editor.videoBlob = finalBlob;
            
            if (typeof this.studio.editor._generateFileName === 'function') {
                this.studio.editor.fileName = `${this.studio.editor._generateFileName()}_rendered`;
            } else {
                this.studio.editor.fileName = `render_${Date.now()}`;
            }

            this.studio.editor.currentExtension = finalExt; 
            const url = URL.createObjectURL(finalBlob);
            await this.studio.editor._loadVideo(url);
            
            if (finalExt === 'mp4') {
                const sig = `0.00_${duration.toFixed(2)}_${finalBlob.size}`;
                this.studio.editor.cachedMp4 = { blob: finalBlob, signature: sig };
            }

            if (this.studio.editor.ui && this.studio.editor.ui.video) {
                this.studio.editor.ui.video.pause(); 
            }

            // AGORA SIM: Restaura o som e libera a UI
            this.studio.playbackManager.stop(); // Agora pode resetar para o início
            if (this.studio.playbackManager.toggleMonitorMute) {
                this.studio.playbackManager.toggleMonitorMute(false);
            }

            this.isRendering = false; // Libera flag global

            this.studio.editor._enableButtons();
            this.studio.toggleMode();
            
            const overlay = document.getElementById('render-progress-overlay');
            if(overlay) overlay.classList.add('hidden');
            const btn = document.getElementById("btn-studio-render");
            if(btn) btn.disabled = false;

        }, 500);
    }

    // ... (cancelRendering, _showProgressOverlay, _fmt e updateProgress mantidos iguais) ...
    // Vou colocar o updateProgress aqui para garantir que ele aceite os novos parâmetros se tiver mudado
    
    updateProgress(percentage, infoText, remainingSeconds, elapsedSeconds) {
        const overlay = document.getElementById('render-progress-overlay');
        if (!this.isRendering || !overlay) return;

        overlay.classList.remove('hidden');
        const fill = overlay.querySelector('.vegas-progress-fill');
        const textPerc = document.getElementById('render-percentage-text');
        const textInfo = document.getElementById('render-speed-text');
        const textLeft = document.getElementById('render-timer-left');
        const textElapsed = document.getElementById('render-timer-elapsed');

        if(fill) fill.style.width = `${percentage * 100}%`;
        if(textPerc) textPerc.innerText = `${Math.round(percentage * 100)}%`;
        if(textInfo) textInfo.innerText = infoText;
        if(textLeft) textLeft.innerText = this._fmt(Math.max(0, remainingSeconds));
        if(textElapsed) textElapsed.innerText = this._fmt(elapsedSeconds);
    }
    
    _showProgressOverlay() {
        const overlay = document.getElementById('render-progress-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            const fill = overlay.querySelector('.vegas-progress-fill');
            if(fill) fill.style.width = '0%';
            
            // Limpa textos
            document.getElementById('render-speed-text').innerText = "Iniciando...";
            document.getElementById('render-timer-left').innerText = "--:--:--";
        }
        const btn = document.getElementById("btn-studio-render");
        if(btn) btn.disabled = true;
    }

    _fmt(s) {
        if (!Number.isFinite(s) || s < 0) return "00:00:00";
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
    
    async cancelRendering() {
        if (this.isRendering) {
            if(confirm("Deseja cancelar?")) {
                this.isRendering = false;
                await this.studio.editor.transcoder.cancelJob();
                
                this.studio.playbackManager.stop();
                if(this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
                if(this.studio.playbackManager.toggleMonitorMute) this.studio.playbackManager.toggleMonitorMute(false);
                
                const overlay = document.getElementById('render-progress-overlay');
                if(overlay) overlay.classList.add('hidden');
                const btn = document.getElementById("btn-studio-render");
                if(btn) btn.disabled = false;
            }
        }
    }
}