import { UIManager } from './managers/UIManager.js';
import { AssetManager } from './managers/AssetManager.js';
import { TimelineManager } from './managers/TimelineManager.js';
import { PlaybackManager } from './managers/PlaybackManager.js';
import { RenderManager } from './managers/RenderManager.js';
import { updateHeaderWidth } from './utils.js';
import { ProjectStorage } from '../../services/ProjectStorage.js';
import { VideoStorage } from '../../services/VideoStorage.js';

export class StudioManager {
    constructor(editorManager) {
        this.editor = editorManager;
        this.isActive = false;
        
        this.project = {
            id: null,
            name: "Novo Projeto",
            settings: { width: 1280, height: 720 },
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

        this.isFreshInit = true;

        this.uiManager = new UIManager(this);
        this.assetManager = new AssetManager(this);
        this.timelineManager = new TimelineManager(this);
        this.playbackManager = new PlaybackManager(this);
        this.renderManager = new RenderManager(this);
        
        this.projectStorage = new ProjectStorage(); 
    }

    async init() {
        // Inicializa a UI básica
        this.uiManager.buildUI();
        
        // Inicializa subsistemas
        this.assetManager.init();
        this.timelineManager.init();
        this.playbackManager.init();
        this.renderManager.init();

        // Verifica se há um ID de projeto na URL (para carregamento direto)
        const projectIdFromUrl = new URLSearchParams(window.location.search).get('projectId');
        
        if (projectIdFromUrl) {
            // Se veio um ID, carrega o projeto salvo e ignora a modal de novo projeto
            await this.loadProject(projectIdFromUrl); // Assumindo que este método já existe ou será criado
            this.isFreshInit = false;
        }

        // Aplica o aspecto visual inicial ao player
        this.uiManager.updatePreviewViewport();

        // Lógica da Modal de Novo Projeto
        if (this.isFreshInit) {
            // Abre a modal. O botão "OK" dessa modal chamará 'checkForPendingRecording'
            this.uiManager.promptProjectSettings();
        } else {
            // Se já carregamos um projeto existente, limpamos qualquer gravação pendente para não confundir
            await this.clearPendingRecordingId();
        }
    }

    /**
     * Verifica se existe uma gravação recente no storage e a importa para o projeto.
     * Chamado pelo UIManager após definir as configurações do projeto.
     */
    async checkForPendingRecording() {
        try {
            // 1. Verifica se há ID de vídeo gravado
            const data = await chrome.storage.local.get(["videoId"]);
            if (!data.videoId) return;

            this.uiManager.updateStatusBar([{ label: "Importando gravação..." }]);

            // 2. Recupera o Blob do IndexedDB
            const storage = new VideoStorage();
            const videoBlob = await storage.getVideo(data.videoId);
            
            if (!videoBlob) {
                console.warn("Vídeo não encontrado no storage.");
                return;
            }

            // 3. Converte para File para o AssetManager
            const ext = videoBlob.type.includes("mp4") ? "mp4" : "webm";
            const fileName = `gravacao_${new Date().getTime()}.${ext}`;
            const videoFile = new File([videoBlob], fileName, { type: videoBlob.type });

            // 4. Importa para o Bin de Mídia
            const asset = await this.assetManager.importAsset(videoFile, fileName);
            
            // 5. Opcional: Adicionar automaticamente à timeline se desejar
            if (asset) {
                // Adiciona na track de vídeo 1 no tempo 0
                this.timelineManager.addClipToTrack("track_v1", asset, 0);
            }

            console.log("Gravação importada com sucesso.");

            // 6. Limpa o registro para não importar novamente no futuro
            await this.clearPendingRecordingId();

        } catch (e) {
            console.error("Erro ao importar gravação pendente:", e);
            alert("Falha ao carregar a gravação: " + e.message);
        } finally {
            this.uiManager.updateStatusBar([]); // Limpa status
        }
    }

    async clearPendingRecordingId() {
        await chrome.storage.local.remove(["videoId"]);
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