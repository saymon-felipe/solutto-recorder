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
                { id: 1, type: 'video', name: 'V1 Principal', clips: [] },
                { id: 2, type: 'video', name: 'V2 Overlay', clips: [] },
                { id: 3, type: 'audio', name: 'A1 Áudio Orig.', clips: [] },
                { id: 4, type: 'audio', name: 'A2 Música/FX', clips: [] }
            ],
            assets: [],
            zoom: 20, 
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
}