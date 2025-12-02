import { UIManager } from './managers/UIManager.js';
import { AssetManager } from './managers/AssetManager.js';
import { TimelineManager } from './managers/TimelineManager.js';
import { PlaybackManager } from './managers/PlaybackManager.js';
import { RenderManager } from './managers/RenderManager.js';
import { updateHeaderWidth } from './utils.js';
import { ProjectStorage } from '../../services/ProjectStorage.js';

export class StudioManager {
    constructor(editorManager) {
        this.editor = editorManager;
        this.isActive = false;
        
        this.project = {
            id: null,
            name: "Novo Projeto",
            tracks: [
                { id: "track_v1", type: 'video', name: 'Video 1', clips: [] },
                { id: "track_a1", type: 'audio', name: 'Audio 1', clips: [] }
            ],
            assets: [],
            zoom: 100, 
            duration: 300, 
            currentTime: 0
        };

        this.tasks = [];
        this.draggedAsset = null;

        this.uiManager = new UIManager(this);
        this.assetManager = new AssetManager(this);
        this.timelineManager = new TimelineManager(this);
        this.playbackManager = new PlaybackManager(this);
        this.renderManager = new RenderManager(this);
        
        this.projectStorage = new ProjectStorage(); 
    }

    init() {
        this.projectStorage.init().catch(console.error);

        // 1. Constroi a UI
        this.uiManager.buildUI();
        
        // 2. Renderiza Tracks (necessário para inicializar o PlaybackManager corretamente depois)
        this.timelineManager.renderRuler();
        this.timelineManager.renderTracks();

        // 3. Inicializa Listeners
        this.timelineManager.init();
        this.playbackManager.init();
        this.renderManager.init();
        
        this.uiManager.updateRecentProjectsList();

        setTimeout(() => {
            const h = document.querySelector('.track-header');
            if(h) updateHeaderWidth(h.getBoundingClientRect().width);
        }, 100);

        // CORREÇÃO: Carregamento robusto da gravação
        if (this.editor.videoBlob) {
            console.log("Importando gravação original...");
            this.assetManager.importAsset(this.editor.videoBlob, "Gravação Original");
            
            // Aguarda o processamento terminar
            const checkInterval = setInterval(() => {
                const asset = this.project.assets[0];
                if (asset && asset.status === 'ready') {
                    clearInterval(checkInterval);
                    console.log("Gravação pronta, adicionando à timeline...");
                    this.addAssetToTimeline(asset, 0); // Usa o método inteligente
                }
            }, 500);
        }
    }

    toggleMode() {
        let app = document.getElementById("studio-app");
        this.isActive = !this.isActive;
        
        if (this.isActive) {
            if (!app) {
                this.init(); // Inicializa na primeira vez
                app = document.getElementById("studio-app");
            }
            
            if (app) app.style.display = "flex";
            
            // Reforça o layout ao abrir
            if(this.timelineManager) {
                this.timelineManager.renderRuler();
                this.timelineManager.renderTracks();
            }
        } else {
            if (app) app.style.display = "none";
            this.playbackManager.pause();
        }
    }

    addTask(label, promiseFn) {
        const id = Date.now();
        this.tasks.push({ id, label });
        this.uiManager.updateStatusBar(this.tasks);
        
        const execution = typeof promiseFn === 'function' ? promiseFn() : promiseFn;
        
        return Promise.resolve(execution)
            .catch(err => console.error(`Erro Task '${label}':`, err))
            .finally(() => {
                this.tasks = this.tasks.filter(t => t.id !== id);
                this.uiManager.updateStatusBar(this.tasks);
            });
    }

    // --- PERSISTÊNCIA ---
    async saveCurrentProject() {
        if (this.tasks.length > 0) return alert("Aguarde o processamento de assets antes de salvar.");

        const defaultName = this.project.name !== "Novo Projeto" ? this.project.name : `Projeto ${new Date().toLocaleString()}`;
        const name = prompt("Nome do Projeto:", defaultName);
        if (!name) return;

        this.project.name = name;
        if (!this.project.id) this.project.id = Date.now();
        this.project.lastSaved = Date.now();

        const assetsToSave = this.project.assets.map(a => ({
            id: a.id,
            name: a.name,
            type: a.type,
            baseDuration: a.baseDuration,
            status: 'ready',
            blob: a.blob
        }));

        const projectData = {
            id: this.project.id,
            name: this.project.name,
            lastSaved: this.project.lastSaved,
            tracks: this.project.tracks,
            assets: assetsToSave,
            zoom: this.project.zoom,
            duration: this.project.duration
        };

        try {
            await this.projectStorage.saveProject(projectData);
            alert("Projeto salvo com sucesso!");
            this.uiManager.updateRecentProjectsList();
        } catch (e) {
            console.error(e);
            alert("Erro ao salvar projeto: " + e.message);
        }
    }

    async loadProject(projectId) {
        if (this.project.assets.length > 0 && !confirm("Carregar projeto? As alterações não salvas atuais serão perdidas.")) return;

        try {
            const data = await this.projectStorage.getProject(projectId);
            if (!data) throw new Error("Projeto não encontrado.");

            const restoredAssets = data.assets.map(a => ({
                ...a,
                url: URL.createObjectURL(a.blob),
                status: 'ready'
            }));

            this.project = {
                id: data.id,
                name: data.name,
                tracks: data.tracks,
                assets: restoredAssets,
                zoom: data.zoom || 100,
                duration: data.duration || 300,
                currentTime: 0
            };

            this.assetManager.renderBin();
            this.timelineManager.renderRuler();
            this.timelineManager.renderTracks();
            this.playbackManager.updatePlayhead();
            this.playbackManager.syncPreview();
            
            const slider = document.getElementById('studio-zoom-slider');
            if(slider) slider.value = this.project.zoom;

        } catch (e) {
            console.error(e);
            alert("Erro ao carregar: " + e.message);
        }
    }
    
    async deleteSavedProject(id) {
        if(!confirm("Excluir este projeto permanentemente?")) return;
        try {
            await this.projectStorage.deleteProject(id);
            this.uiManager.updateRecentProjectsList();
        } catch(e) {
            alert("Erro ao excluir: " + e.message);
        }
    }

    addAssetToTimeline(asset, startTime = 0) {
        const groupId = "group_" + Date.now();
        
        if (asset.type === 'video') {
            const videoTrack = this.project.tracks.find(t => t.type === 'video');
            const audioTrack = this.project.tracks.find(t => t.type === 'audio');
            
            if (videoTrack) {
                this.timelineManager.addClipToTrack(videoTrack.id, asset, startTime, groupId);
                const addedClip = videoTrack.clips[videoTrack.clips.length - 1];
                if(addedClip) addedClip.muted = true;
            }

            const isImage = (asset.originalType && asset.originalType.startsWith('image')) || asset.name.startsWith("[IMG]");
            
            if (audioTrack && !isImage) {
                this.timelineManager.addClipToTrack(audioTrack.id, asset, startTime, groupId);
            }
        } 
        else if (asset.type === 'audio') {
            const audioTrack = this.project.tracks.find(t => t.type === 'audio');
            if (audioTrack) this.timelineManager.addClipToTrack(audioTrack.id, asset, startTime, null);
        }
        else {
             const videoTrack = this.project.tracks.find(t => t.type === 'video');
             if (videoTrack) this.timelineManager.addClipToTrack(videoTrack.id, asset, startTime, null);
        }
    }

    addTrack(type) {
        const count = this.project.tracks.filter(t => t.type === type).length + 1;
        const newTrack = {
            id: `track_${type}_${Date.now()}`,
            type: type,
            name: `${type === 'video' ? 'Video' : 'Audio'} ${count}`,
            clips: []
        };
        this.project.tracks.push(newTrack);
        this.timelineManager.renderTracks();
    }

    reorderTracks(fromIndex, toIndex) {
        const item = this.project.tracks.splice(fromIndex, 1)[0];
        this.project.tracks.splice(toIndex, 0, item);
        this.timelineManager.renderTracks();
    }

    moveClipToTrack(clip, targetTrackId) {
        const currentTrack = this.project.tracks.find(t => t.clips.find(c => c.id === clip.id));
        const targetTrack = this.project.tracks.find(t => t.id === targetTrackId);

        if (!currentTrack || !targetTrack) return false;
        if (currentTrack.type !== targetTrack.type) return false;
        if (currentTrack.id === targetTrack.id) return false;

        currentTrack.clips = currentTrack.clips.filter(c => c.id !== clip.id);
        targetTrack.clips.push(clip);
        return true;
    }
}