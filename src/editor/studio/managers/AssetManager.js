import { getMediaDuration } from '../utils.js';

export class AssetManager {
    constructor(studio) {
        this.studio = studio;
    }

    async importAsset(file, name = "Sem Nome") {
        // Fallback se type estiver vazio
        const mime = file.type ? file.type.split('/')[0] : 'video';
        const assetId = "asset_" + Date.now();
        
        const placeholder = {
            id: assetId,
            name: (mime === 'image' ? "[IMG] " : "") + name,
            type: mime === 'image' ? 'video' : mime,
            blob: null, url: "", baseDuration: 5, status: 'processing'
        };

        this.studio.project.assets.push(placeholder);
        this.renderBin();

        this.studio.addTask(`Processando ${name}...`, async () => {
            const result = await this._createAsset(file, name, mime);
            const idx = this.studio.project.assets.findIndex(a => a.id === assetId);
            if (idx !== -1) {
                this.studio.project.assets[idx] = { ...result, id: assetId, status: 'ready' };
                this.renderBin();
                this.studio.timelineManager.renderTracks(); // Atualiza se já estiver na timeline
            }
        });
    }

    async _createAsset(file, name, mimeOverride) {
        let type; let duration; 
        const blob = new Blob([file], { type: file.type });
        const mime = mimeOverride || file.type.split('/')[0];

        if (mime === 'image') {
            type = 'video'; name = "[IMG] " + name;
            const url = await this.studio.editor.transcoder.imageToVideo(file, 5);
            const res = await fetch(url);
            blob = await res.blob();
            duration = 5;
        } else if (mime === 'video' || mime === 'application') {
            type = 'video'; duration = await getMediaDuration(blob);
        } else if (mime === 'audio') {
            type = 'audio'; duration = await getMediaDuration(blob);
        }
        
        if (duration < 0.1) duration = 10; 
        return { blob, name, type, baseDuration: duration, url: URL.createObjectURL(blob) };
    }

    renderBin() {
        const list = document.getElementById("studio-bin-list");
        if(!list) return;
        list.innerHTML = "";
        this.studio.project.assets.forEach(asset => {
            const item = document.createElement("div");
            item.className = `bin-item type-${asset.type} ${asset.status==='processing'?'processing':''}`;
            item.draggable = asset.status !== 'processing';
            item.innerHTML = `
                <i class="fa-solid ${asset.type==='audio'?'fa-music':(asset.type==='video'?'fa-film':'fa-image')}"></i>
                <span>${asset.name}</span>
                ${asset.status==='processing'?'<i class="fa-solid fa-spinner fa-spin"></i>':''}
            `;
            
            if(asset.status !== 'processing') {
                item.ondragstart = (e) => { 
                    this.studio.draggedAsset = asset;
                    e.dataTransfer.setData('text/plain', asset.id);
                };
            }
            list.appendChild(item);
        });
    }
}