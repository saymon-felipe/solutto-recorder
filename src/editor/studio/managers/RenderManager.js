export class RenderManager {
    constructor(studio) {
        this.studio = studio;
        this.isRendering = false;
        this.renderStartTime = 0;
        this.timerInterval = null; 
        this.estimatedTotalTime = 0;
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
            
            const options = {
                resolution: document.getElementById("render-resolution").value,
                quality: document.getElementById("render-quality").value
            };
            this.renderProject(options);
        };

        document.getElementById("btn-render-abort").addEventListener('click', (e) => {
            this.cancelRendering();
        });
    }

    async cancelRendering() {
        if(!this.isRendering) return;
        if(confirm("Deseja cancelar a renderização?")) {
            await this.studio.editor.transcoder.cancelJob();
            this.isRendering = false;
            this._stopTimerLoop();
            document.getElementById('render-progress-overlay').classList.add('hidden');
        }
    }

    _startTimerLoop() {
        this.renderStartTime = Date.now();
        const elElapsed = document.getElementById('render-timer-elapsed');
        const elLog = document.getElementById('render-log-text');
        
        if(elLog) elLog.innerText = "Preparando arquivos e filtros...";

        this.timerInterval = setInterval(() => {
            const now = Date.now();
            const elapsedSec = (now - this.renderStartTime) / 1000;
            
            // Atualiza o tempo decorrido a cada segundo
            if(elElapsed) elElapsed.innerText = this._fmt(elapsedSec);
            
        }, 1000);
    }

    _stopTimerLoop() {
        if(this.timerInterval) clearInterval(this.timerInterval);
        this.timerInterval = null;
    }

    updateProgress(ratio, speed = 'N/A') {
        const overlay = document.getElementById('render-progress-overlay');
        
        if (this.isRendering && overlay) {
            overlay.classList.remove('hidden');

            const fill = overlay.querySelector('.vegas-progress-fill');
            const textPerc = document.getElementById('render-percentage-text');
            const textSpeed = document.getElementById('render-speed-text');
            const textLog = document.getElementById('render-log-text');
            const textLeft = document.getElementById('render-timer-left');

            const percentage = Math.round(ratio * 100);
            
            if(fill) fill.style.width = `${percentage}%`;
            if(textPerc) textPerc.innerText = `${percentage}%`;
            if(textSpeed) textSpeed.innerText = `${speed}x`;
            if(textLog) textLog.innerText = `Codificando frames... (${percentage}%)`;

            // Cálculo do Tempo Restante
            const elapsed = (Date.now() - this.renderStartTime) / 1000;
            if (ratio > 0.01) {
                const totalEstimated = elapsed / ratio;
                const remaining = totalEstimated - elapsed;
                if(textLeft) textLeft.innerText = this._fmt(remaining);
            } else {
                if(textLeft) textLeft.innerText = "Calculando...";
            }
        }
    }

    _fmt(s) {
        if(!isFinite(s) || s < 0) return "00:00:00";
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    /**
     * Inicia o processo de mixagem e renderização do projeto.
     */
    async renderProject(options = {}) {
        if (this.studio.tasks.length > 0) return alert("Aguarde tarefas pendentes...");
        
        this.isRendering = true;
        document.getElementById('render-progress-overlay').classList.remove('hidden');

        const btn = document.getElementById("btn-studio-render");
        if(btn) { btn.innerHTML = "Renderizando..."; btn.disabled = true; }

        document.getElementById('render-timer-elapsed').innerText = "00:00:00";
        document.getElementById('render-timer-left').innerText = "--:--:--";
        document.querySelector('.vegas-progress-fill').style.width = "0%";
        
        this._startTimerLoop();

        try {
            if (!this.studio.editor.transcoder.isLoaded) {
                document.getElementById('render-log-text').innerText = "Carregando núcleo do FFmpeg...";
                await this.studio.editor.transcoder.init();
            }

            // 1. Coleta TODOS os clipes (áudio e vídeo) e calcula a duração total
            let allClips = [];
            let totalDuration = 0;
            const uniqueAssetIds = new Set();
            
            this.studio.project.tracks.forEach(t => {
                t.clips.forEach(c => {
                    const clipData = { ...c, trackId: t.id, trackType: t.type };
                    allClips.push(clipData);
                    uniqueAssetIds.add(c.assetId);
                    totalDuration = Math.max(totalDuration, c.start + c.duration);
                });
            });

            if (allClips.length === 0 || totalDuration === 0) throw new Error("Timeline vazia ou duração zero.");

            // 2. Pré-processamento e Mapeamento de Assets (Blob final)
            const assetsMap = {}; 
            for (const assetId of uniqueAssetIds) {
                const asset = this.studio.project.assets.find(a => a.id === assetId);
                if (!this.isRendering) throw new Error("Cancelado.");

                if (!asset || asset.status !== 'ready') {
                    console.warn(`[Render] Asset ignorado (não encontrado ou não pronto): ${assetId}`);
                    continue;
                }

                document.getElementById('render-log-text').innerText = `Processando asset: ${asset.name}...`;
                
                let finalBlob = asset.blob;
                
                // Aplica Fader (apenas se houver clipe de vídeo com level < 1)
                const videoClipNeedsFader = allClips.some(c => c.assetId === assetId && c.trackType === 'video' && c.level < 1);
                
                if (videoClipNeedsFader) {
                    try {
                        const faderBlob = await this.studio.addTask("Aplicando Fader...", async () => { 
                            const url = await this.studio.editor.transcoder.processVideo(
                                asset.blob, "fader_" + asset.id, 0, asset.baseDuration, "webm", { opacity: allClips.find(c => c.assetId === asset.id).level }
                            );
                            const res = await fetch(url);
                            return await res.blob();
                        });
                        
                        if (faderBlob) finalBlob = faderBlob;
                    } catch (err) {
                        console.error(`[Render] Erro ao aplicar fader no asset ${assetId}. Usando original.`, err);
                    }
                }

                if (!finalBlob || finalBlob.size === 0) {
                    console.error(`[Render] Blob inválido para asset: ${assetId}`);
                    continue;
                }

                assetsMap[assetId] = finalBlob;
            }

            if (Object.keys(assetsMap).length === 0) {
                throw new Error("Não foi possível preparar os arquivos de mídia. Verifique se os assets estão carregados corretamente.");
            }
            
            // 3. Chamar mixProject: Lógica complexa de FFmpeg para combinar áudio e vídeo
            const progressCallback = (ratio, speed) => {
                if(!this.isRendering) return;
                this.updateProgress(ratio, speed);
            };

            const url = await this.studio.editor.transcoder.mixProject(
                allClips,
                assetsMap,
                totalDuration,
                progressCallback,
                options
            );
            
            const res = await fetch(url);
            this.studio.editor.videoBlob = await res.blob();
            await this.studio.editor._loadVideo(url);
            
            this.studio.toggleMode(); 

        } catch(e) { 
            if (!this.isRendering) {
                console.warn("Renderização cancelada pelo usuário.");
            } else {
                alert("Erro: " + e.message);
            }
        } finally {
            this.isRendering = false;
            this._stopTimerLoop(); 
            document.getElementById('render-progress-overlay').classList.add('hidden');
            this.studio.editor._setLoading(false);

            if(btn) {
                btn.innerHTML = `<i class="fa-solid fa-file-export"></i> Renderizar`; 
                btn.disabled = false;
            }
        }
    }
}