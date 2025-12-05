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
            
            const formatInput = document.getElementById("render-format");
            const formatVal = formatInput ? formatInput.value : 'mp4';

            const options = {
                resolution: document.getElementById("render-resolution").value,
                quality: document.getElementById("render-quality").value,
                format: formatVal
            };
            this.renderProject(options);
        };

        const btnAbort = document.getElementById("btn-render-abort");
        if(btnAbort) btnAbort.onclick = () => this.cancelRendering();

        const resSelect = document.getElementById("render-resolution");
        if(resSelect) {
            const { width, height } = this.studio.project.settings;
            // Cria uma opção única com a resolução do projeto
            resSelect.innerHTML = `<option value="project" selected>Projeto (${width}x${height})</option>`;
            resSelect.disabled = true;
        }
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
        
        if(elLog) elLog.innerText = "Iniciando motor...";

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
            if(textLog) textLog.innerText = `Processando... (${percentage}%)`;

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

    async _optimizeImage(blob, targetW, targetH) {
        try {
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            const scale = Math.min(targetW / bitmap.width, targetH / bitmap.height);
            const w = Math.round(bitmap.width * scale);
            const h = Math.round(bitmap.height * scale);
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, w, h);
            return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        } catch (e) {
            console.warn("Falha ao otimizar imagem, usando original:", e);
            return blob;
        }
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
                document.getElementById('render-log-text').innerText = "Carregando núcleo FFmpeg...";
                await this.studio.editor.transcoder.init();
            }

            const projectW = this.studio.project.settings.width;
            const projectH = this.studio.project.settings.height;

            const targetRes = { w: projectW, h: projectH };

            // 1. Coleta de Assets e Análise de Complexidade
            let allClips = [];
            let totalDuration = 0;
            const uniqueAssetIds = new Set();
            let hasComplexContent = false; // Flag para forçar MP4
            
            this.studio.project.tracks.forEach(t => {
                t.clips.forEach(c => {
                    const clipData = { ...c, trackId: t.id, trackType: t.type };
                    allClips.push(clipData);
                    uniqueAssetIds.add(c.assetId);
                    totalDuration = Math.max(totalDuration, c.start + c.duration);

                    // Detecção de Complexidade:
                    // Se for Imagem (Overlay) ou tiver Opacidade < 1, é complexo.
                    const asset = this.studio.project.assets.find(a => a.id === c.assetId);
                    if (asset && asset.type.startsWith('image')) hasComplexContent = true;
                    if (c.level !== undefined && c.level < 1) hasComplexContent = true;
                });
            });

            allClips.sort((a, b) => a.start - b.start);

            if (allClips.length === 0) throw new Error("Timeline vazia.");

            // 2. SWITCH AUTOMÁTICO PARA MP4 (PROTEÇÃO DE PERFORMANCE)
            if (hasComplexContent && options.format === 'webm') {
                console.warn("[Solutto Recorder] Detectado conteúdo complexo (Imagens/Opacidade). Alternando para MP4 para garantir performance.");
                options.format = 'mp4';
                // Atualiza UI para o usuário saber (opcional, ou apenas processa internamente)
                document.getElementById('render-log-text').innerText = "Otimizando para MP4 (Detectado Imagens)...";
            }

            // 3. Preparação de Assets
            let assetsMap = {}; 
            document.getElementById('render-log-text').innerText = `Otimizando assets (GPU)...`;

            for (const assetId of uniqueAssetIds) {
                const asset = this.studio.project.assets.find(a => a.id === assetId);
                if (!asset || asset.status !== 'ready') continue;
                
                let blobToUse = asset.sourceBlob || asset.blob;

                if (asset.type.startsWith('image')) {
                    blobToUse = await this._optimizeImage(blobToUse, parseInt(targetRes.w), parseInt(targetRes.h));
                }

                assetsMap[assetId] = blobToUse;
            }

            if (!this.isRendering) throw new Error("Cancelado.");

            document.getElementById('render-log-text').innerText = `Gerando video (${options.format.toUpperCase()})...`;
            
            const progressCallback = (ratio, speed) => {
                if(this.isRendering) this.updateProgress(ratio, speed);
            };

            const url = await this.studio.editor.transcoder.mixProject(
                allClips,
                assetsMap,
                totalDuration,
                progressCallback,
                { ...options, width: projectW, height: projectH }
            );
            
            const res = await fetch(url);
            this.studio.editor.videoBlob = await res.blob();
            // Atualiza a extensão correta no editor (caso tenha mudado automaticamente)
            this.studio.editor.currentExtension = options.format === 'mp4' ? 'mp4' : 'webm';
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