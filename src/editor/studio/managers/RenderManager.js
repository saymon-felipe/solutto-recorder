export class RenderManager {
    constructor(studio) {
        this.studio = studio;
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
    }

    updateProgress(ratio, speed = 'N/A') {
        const progressBar = document.getElementById('render-progress-bar');
        if (progressBar && !progressBar.classList.contains('hidden')) {
            const fill = progressBar.querySelector('.progress-fill');
            const text = document.getElementById('progress-text');

            const percentage = Math.round(ratio * 100);
            
            fill.style.width = `${percentage}%`;
            text.innerText = `${percentage}% - Velocidade: ${speed}x`;
        }
    }

    /**
     * Inicia o processo de mixagem e renderização do projeto.
     */
    async renderProject(options = {}) {
        if (this.studio.tasks.length > 0) return alert("Aguarde tarefas pendentes...");
        
        const btn = document.getElementById("btn-studio-render");
        if(btn) { btn.innerHTML = "Renderizando..."; btn.disabled = true; }

        document.getElementById('render-progress-bar').classList.remove('hidden');
        this.updateProgress(0, '...');

        try {
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
                if (!asset || asset.status !== 'ready') continue;
                
                let finalBlob = asset.blob;
                
                // Aplica Fader (apenas se houver clipe de vídeo com level < 1)
                const videoClipNeedsFader = allClips.some(c => c.assetId === assetId && c.trackType === 'video' && c.level < 1);
                
                if (videoClipNeedsFader) {
                    finalBlob = await this.studio.addTask("Aplicando Fader...", async () => { 
                        const url = await this.studio.editor.transcoder.processVideo(
                            asset.blob, "fader_" + asset.id, 0, asset.baseDuration, "webm", { opacity: allClips.find(c => c.assetId === asset.id).level }
                        );
                        const res = await fetch(url);
                        return await res.blob();
                    });
                }

                if (!finalBlob || finalBlob.size === 0) continue;
                assetsMap[assetId] = finalBlob;
            }
            
            // 3. Chamar mixProject: Lógica complexa de FFmpeg para combinar áudio e vídeo
            const progressCallback = (ratio, speed) => this.updateProgress(ratio, speed);

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
            alert(e.message||e);
        } finally {
            document.getElementById('render-progress-bar').classList.add('hidden');
            if(btn) {
                btn.innerHTML = `<i class="fa-solid fa-file-export"></i> Renderizar`; 
                btn.disabled = false;
            }
            this.studio.editor._setLoading(false); 
        }
    }
}