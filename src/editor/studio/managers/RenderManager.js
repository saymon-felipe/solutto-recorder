export class RenderManager {
    constructor(studio) {
        this.studio = studio;
        this.isRendering = false;
        this.renderStartTime = 0;
        this.timerInterval = null; 
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
            
            // Captura as opções, incluindo o novo Formato
            const options = {
                resolution: document.getElementById("render-resolution").value,
                quality: document.getElementById("render-quality").value,
                format: document.getElementById("render-format") ? document.getElementById("render-format").value : 'webm'
            };
            this.renderProject(options);
        };

        const btnAbort = document.getElementById("btn-render-abort");
        if(btnAbort) btnAbort.onclick = () => this.cancelRendering();
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
        
        if(elLog) elLog.innerText = "Preparando assets...";

        this.timerInterval = setInterval(() => {
            const now = Date.now();
            const elapsedSec = (now - this.renderStartTime) / 1000;
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
            if(textLog) textLog.innerText = `Renderizando... (${percentage}%)`;

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

    async renderProject(options = {}) {
        if (this.studio.tasks.length > 0) return alert("Aguarde tarefas pendentes...");
        
        this.isRendering = true;
        document.getElementById('render-progress-overlay').classList.remove('hidden');

        const btn = document.getElementById("btn-studio-render");
        if(btn) { btn.innerHTML = "Renderizando..."; btn.disabled = true; }

        document.getElementById('render-timer-elapsed').innerText = "00:00:00";
        document.querySelector('.vegas-progress-fill').style.width = "0%";
        
        this._startTimerLoop();

        try {
            if (!this.studio.editor.transcoder.isLoaded) {
                document.getElementById('render-log-text').innerText = "Carregando FFmpeg...";
                await this.studio.editor.transcoder.init();
            }

            // 1. Coleta e mapeamento de clips
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

            // CORREÇÃO CRÍTICA: Ordena os clipes cronologicamente pela timeline.
            // Sem isso, o filtro concat une os vídeos na ordem errada (ex: por ordem de track).
            allClips.sort((a, b) => a.start - b.start);

            if (allClips.length === 0) throw new Error("Timeline vazia.");

            // 2. Processamento Paralelo de Assets (WebM Interno)
            let assetsMap = {}; 
            const assetsToProcess = [];
            const assetsReady = [];

            for (const assetId of uniqueAssetIds) {
                const asset = this.studio.project.assets.find(a => a.id === assetId);
                if (!asset || asset.status !== 'ready') continue;

                // Verifica necessidade de fader (processamento)
                const needsFader = allClips.some(c => c.assetId === assetId && c.trackType === 'video' && c.level < 1);
                
                if (needsFader) assetsToProcess.push(asset);
                else assetsReady.push(asset);
            }

            assetsReady.forEach(asset => { assetsMap[asset.id] = asset.blob; });

            if (assetsToProcess.length > 0) {
                document.getElementById('render-log-text').innerText = `Otimizando ${assetsToProcess.length} clips...`;
                
                await Promise.all(assetsToProcess.map(asset => {
                    return this.studio.addTask(`Otimizando: ${asset.name}`, async () => {
                        if (!this.isRendering) return;
                        
                        // Busca o primeiro clipe que usa esse asset para pegar o nível de opacidade
                        const clipRef = allClips.find(c => c.assetId === asset.id);
                        const opacityLevel = clipRef ? clipRef.level : 1;

                        try {
                            // Mantém WebM internamente (format: 'webm')
                            const url = await this.studio.editor.transcoder.processVideo(
                                asset.blob, "fader_" + asset.id, 0, asset.baseDuration, "webm", { opacity: opacityLevel }
                            );
                            const res = await fetch(url);
                            assetsMap[asset.id] = await res.blob();
                        } catch (err) {
                            console.error(`Erro asset ${asset.name}`, err);
                            assetsMap[asset.id] = asset.blob; // Fallback
                        }
                    });
                }));
            }

            if (!this.isRendering) throw new Error("Cancelado.");

            // 3. Mixagem Final (Respeitando o formato escolhido)
            document.getElementById('render-log-text').innerText = `Mixando em ${options.format.toUpperCase()}...`;
            
            const progressCallback = (ratio, speed) => {
                if(this.isRendering) this.updateProgress(ratio, speed);
            };

            const url = await this.studio.editor.transcoder.mixProject(
                allClips,
                assetsMap,
                totalDuration,
                progressCallback,
                options
            );
            
            // Carrega o vídeo final no Editor
            const res = await fetch(url);
            this.studio.editor.videoBlob = await res.blob();
            this.studio.editor.currentExtension = options.format === 'mp4' ? 'mp4' : 'webm'; // Atualiza extensão
            await this.studio.editor._loadVideo(url);
            
            this.studio.toggleMode(); 

        } catch(e) { 
            if (!this.isRendering) console.warn("Cancelado.");
            else alert("Erro na renderização: " + e.message);
        } finally {
            this.isRendering = false;
            this._stopTimerLoop(); 
            document.getElementById('render-progress-overlay').classList.add('hidden');
            this.studio.editor._setLoading(false);
            if(btn) { btn.innerHTML = `<i class="fa-solid fa-file-export"></i> Renderizar`; btn.disabled = false; }
        }
    }
}