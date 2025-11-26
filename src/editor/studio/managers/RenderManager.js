export class RenderManager {
    constructor(studio) {
        this.studio = studio;
    }

    init() {
        document.getElementById("btn-studio-render").onclick = () => this.renderProject();
    }

    async renderProject() {
        if (this.studio.tasks.length > 0) return alert("Aguarde tarefas pendentes...");
        
        const btn = document.getElementById("btn-studio-render");
        btn.innerHTML = "Renderizando..."; btn.disabled = true;

        try {
            const videoTracks = this.studio.project.tracks.filter(t => t.type === 'video');
            let clips = [];
            videoTracks.forEach(t => clips.push(...t.clips));
            clips.sort((a,b) => a.start - b.start);

            if (clips.length === 0) throw new Error("Nada para renderizar.");

            const blobs = [];
            for (const clip of clips) {
                const asset = this.studio.project.assets.find(a => a.id === clip.assetId);
                if (!asset || asset.status !== 'ready') continue;

                let blobToUse = asset.blob;
                
                // Aplica Fader se < 1
                if (clip.level < 1) {
                    this.studio.addTask("Aplicando Fader...", async () => {
                        const url = await this.studio.editor.transcoder.processVideo(
                            asset.blob, "fader_" + clip.id, 0, asset.baseDuration, "webm", { opacity: clip.level }
                        );
                        const res = await fetch(url);
                        blobToUse = await res.blob();
                    });
                }

                const loops = Math.ceil(clip.duration / asset.baseDuration);
                for(let i=0; i<loops; i++) blobs.push(blobToUse);
            }

            if (this.studio.tasks.length > 0) throw new Error("Processando efeitos... Tente novamente.");

            const url = await this.studio.editor.transcoder.mergeSegments(blobs, "final");
            const res = await fetch(url);
            this.studio.editor.videoBlob = await res.blob();
            await this.studio.editor._loadVideo(url);
            
            this.studio.toggleMode();

        } catch(e) { alert(e.message||e); } finally { btn.innerHTML = "Renderizar"; btn.disabled = false; }
    }
}