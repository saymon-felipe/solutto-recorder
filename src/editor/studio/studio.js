import { UIManager } from './managers/UIManager.js';
import { AssetManager } from './managers/AssetManager.js';
import { TimelineManager } from './managers/TimelineManager.js';
import { PlaybackManager } from './managers/PlaybackManager.js';
import { RenderManager } from './managers/RenderManager.js';
import { updateHeaderWidth } from './utils.js';

export class StudioManager {
    constructor(editorManager) {
        this.editor = editorManager;
        this.isActive = false;
        
        this.project = {
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

        // Inicializa Managers
        this.uiManager = new UIManager(this);
        this.assetManager = new AssetManager(this);
        this.timelineManager = new TimelineManager(this);
        this.playbackManager = new PlaybackManager(this);
        this.renderManager = new RenderManager(this);
    }

    init() {
        this.uiManager.buildUI();
        this.playbackManager.init();
        this.timelineManager.init();
        this.renderManager.init();

        // Mede a largura real do cabeçalho da track para alinhar a agulha
        setTimeout(() => {
            const h = document.querySelector('.track-header');
            if(h) updateHeaderWidth(h.getBoundingClientRect().width);
        }, 500);
    }

    toggleMode() {
        this.isActive = !this.isActive;
        const el = document.getElementById("studio-app");
        el.style.display = this.isActive ? "flex" : "none";
        
        if (this.isActive) {
            // Auto-importação
            if (this.project.assets.length === 0 && this.editor.videoBlob) {
                this.assetManager.importAsset(this.editor.videoBlob, "Gravação Original").then(() => {
                    // Adiciona à timeline após processar
                    // O assetManager cuida de adicionar na lista, aqui pegamos e botamos na track
                    setTimeout(() => {
                        const asset = this.project.assets[0];
                        if(asset && asset.status === 'ready') {
                            this.timelineManager.addClipToTrack(1, asset, 0);
                            this.timelineManager.addClipToTrack(3, asset, 0);
                        }
                    }, 200);
                });
            }
            this.uiManager.updateStatusBar(this.tasks);
            this.timelineManager.renderRuler();
            this.timelineManager.renderTracks();
        } else {
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

    /**
     * Adiciona um asset à timeline de forma inteligente.
     * Se for vídeo com áudio, separa em duas tracks e vincula.
     */
    addAssetToTimeline(asset, startTime = 0) {
        const groupId = "group_" + Date.now();
        
        if (asset.type === 'video') {
            const videoTrack = this.project.tracks.find(t => t.type === 'video');
            const audioTrack = this.project.tracks.find(t => t.type === 'audio');
            
            // 1. Adiciona Vídeo (MUDO, pois o áudio irá para baixo)
            if (videoTrack) {                
                this.timelineManager.addClipToTrack(videoTrack.id, asset, startTime, groupId);
                
                const addedClip = videoTrack.clips[videoTrack.clips.length - 1];
                if(addedClip) addedClip.muted = true; 
            }
            
            // 2. Adiciona Áudio Separado
            if (audioTrack) {
                this.timelineManager.addClipToTrack(audioTrack.id, asset, startTime, groupId);
            }
        } 
        else if (asset.type === 'audio') {
             const audioTrack = this.project.tracks.find(t => t.type === 'audio');
             if (audioTrack) this.timelineManager.addClipToTrack(audioTrack.id, asset, startTime, null);
        }
        else {
             // Imagens
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

    // Valida e move o clip de track
    moveClipToTrack(clip, targetTrackId) {
        const currentTrack = this.project.tracks.find(t => t.clips.find(c => c.id === clip.id));
        const targetTrack = this.project.tracks.find(t => t.id === targetTrackId);

        if (!currentTrack || !targetTrack) return false;
        
        // --- VALIDAÇÃO DE TIPO (Video só em Video, Audio só em Audio) ---
        if (currentTrack.type !== targetTrack.type) return false;
        if (currentTrack.id === targetTrack.id) return false;

        // Move os dados
        currentTrack.clips = currentTrack.clips.filter(c => c.id !== clip.id);
        
        targetTrack.clips.push(clip);
        
        return true;
    }
}