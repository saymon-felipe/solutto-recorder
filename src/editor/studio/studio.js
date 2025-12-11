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

        this.hasUnsavedChanges = false;
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
            await this.loadProject(projectIdFromUrl); 
            this.isFreshInit = false;
        }

        // Aplica o aspecto visual inicial ao player
        this.uiManager.updatePreviewViewport();
        this.uiManager.updateRecentProjectsList();

        // Lógica da Modal de Novo Projeto
        if (this.isFreshInit) {
            // Abre a modal. O botão "OK" dessa modal chamará 'checkForPendingRecording'
            this.uiManager.promptProjectSettings();
        } else {
            // Se já carregamos um projeto existente, limpamos qualquer gravação pendente para não confundir
            await this.clearPendingRecordingId();
        }

        this.uiManager.updateProjectHeader(this.project, this.hasUnsavedChanges);
    }

    markUnsavedChanges() {
        this.hasUnsavedChanges = true;

        if (this.uiManager) {
            this.uiManager.updateProjectHeader(this.project, true);
        }
    }
    
    markSaved() {
        this.hasUnsavedChanges = false;
        this.project.lastSaved = Date.now();
        this.uiManager.updateProjectHeader(this.project, this.hasUnsavedChanges);
        this.uiManager.updateRecentProjectsList();
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

    // =========================================================================
    // PERSISTÊNCIA E SALVAMENTO (Corrigido para Cache e Blobs)
    // =========================================================================

    /**
     * Salva o projeto atual.
     * Lógica: Se já tem ID, atualiza. Se não tem (Novo Projeto), chama o Salvar Como.
     */
    async saveProject() {
        if (this.tasks.length > 0) return alert("Aguarde o processamento de assets antes de salvar.");

        if (!this.project.id || this.project.name === "Novo Projeto") {
            return this.saveProjectAs();
        }

        await this._performSave(this.project.id, this.project.name);
    }

    /**
     * Cria uma CÓPIA do projeto atual com um novo ID.
     */
    async saveProjectAs() {
        if (this.tasks.length > 0) return alert("Aguarde o processamento de assets antes de salvar.");

        const defaultName = this.project.name !== "Novo Projeto" ? `${this.project.name} (Cópia)` : `Meu Projeto`;
        const name = prompt("Salvar projeto como:", defaultName);
        if (!name) return;

        // Gera um NOVO ID para criar uma nova entrada no banco
        const newId = `proj_${Date.now()}`;
        
        await this._performSave(newId, name);
    }

    /**
     * Método interno que executa a persistência no ProjectStorage.
     */
    async _performSave(id, name) {
        this.project.id = id;
        this.project.name = name;
        this.project.lastSaved = Date.now();

        const serializableAssets = await this.assetManager.getSerializableAssets();
        
        const projectData = {
            id: this.project.id,
            name: this.project.name,
            lastSaved: this.project.lastSaved,
            settings: this.project.settings, 
            tracks: this.project.tracks,
            assets: serializableAssets, 
            zoom: this.project.zoom,
            duration: this.project.duration,
            currentTime: this.project.currentTime,
        };

        try {
            await this.projectStorage.saveProject(projectData);
            
            this.markSaved();
            this.uiManager.updateRecentProjectsList();
            
        } catch (e) {
            console.error("Erro ao salvar:", e);
            alert("Erro ao salvar projeto: " + e.message);
        }
    }

    /**
     * Abre o modal de configurações (Resolução/Orientação)
     */
    openProjectSettings() {
        this.uiManager.promptProjectSettings();
    }

    async loadProject(projectId) {
        if (this.project.assets.length > 0 && !confirm("Carregar projeto? As alterações não salvas atuais serão perdidas.")) return;

        try {
            const data = await this.projectStorage.getProject(projectId);
            if (!data) throw new Error("Projeto não encontrado.");

            const videoStorage = new VideoStorage();
            
            const restoredAssets = await Promise.all(data.assets.map(async a => {
                let mediaBlob = null;
                let url = '';
                let assetStatus = 'processing';

                if (a.id) {
                    mediaBlob = await videoStorage.getVideo(a.id); 
                }
                
                if (mediaBlob) {
                    url = URL.createObjectURL(mediaBlob); 
                    assetStatus = 'ready';
                } else {
                    assetStatus = 'unloaded'; 
                    console.warn(`Asset ${a.name} (ID: ${a.id}) media content not found. Asset marked as 'unloaded'.`);
                }
                
                return {
                    ...a,
                    blob: mediaBlob, 
                    sourceBlob: mediaBlob, 
                    url: url,
                    status: assetStatus
                };
            }));

            this.project = {
                id: data.id,
                name: data.name,
                tracks: data.tracks,
                assets: restoredAssets, 
                settings: data.settings || { width: 1280, height: 720 }, 
                zoom: data.zoom || 100,
                duration: data.duration || 300,
                currentTime: data.currentTime || 0 
            };

            this.assetManager.renderBin();
            this.timelineManager.renderRuler();
            this.timelineManager.renderTracks();
            this.assetManager.indexAllExistingAssets(); 
            this.playbackManager.updatePlayhead();
            this.playbackManager.syncPreview();
            
            this.uiManager.updatePreviewViewport();

            const slider = document.getElementById('studio-zoom-slider');
            if(slider) slider.value = this.project.zoom;

            this.uiManager.updateProjectHeader(this.project, false);
            
            this.uiManager.showToast(`Projeto "${this.project.name}" carregado.`);

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

    deleteTrack(trackId) {
        const trackIndex = this.project.tracks.findIndex(t => t.id === trackId);
        if (trackIndex === -1) return;

        this.historyManager.recordState();

        this.project.tracks.splice(trackIndex, 1);

        this.timelineManager.renderTracks();
        this.markUnsavedChanges();
        
        if (this.playbackManager) {
            this.playbackManager.syncPreview(); 
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

        this.markUnsavedChanges();
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
        this.markUnsavedChanges();
    }

    reorderTracks(fromIndex, toIndex) {
        const item = this.project.tracks.splice(fromIndex, 1)[0];
        this.project.tracks.splice(toIndex, 0, item);
        this.timelineManager.renderTracks();
        this.markUnsavedChanges();
    }

    moveClipToTrack(clip, targetTrackId) {
        const currentTrack = this.project.tracks.find(t => t.clips.find(c => c.id === clip.id));
        const targetTrack = this.project.tracks.find(t => t.id === targetTrackId);

        if (!currentTrack || !targetTrack) return false;
        if (currentTrack.type !== targetTrack.type) return false;
        if (currentTrack.id === targetTrack.id) return false;

        currentTrack.clips = currentTrack.clips.filter(c => c.id !== clip.id);
        targetTrack.clips.push(clip);
        this.markUnsavedChanges();
        return true;
    }

    async createSubtitleAsset(config) {
        // Encontra ou cria track para legendas
        let targetTrack = this.project.tracks.find(t => t.type === 'video' && t.clips.length === 0);
        if (!targetTrack) {
            this.addTrack('video');
            targetTrack = this.project.tracks[this.project.tracks.length - 1];
            targetTrack.name = "Legendas";
        }

        const duration = 5; // Duração fixa de 5 segundos
        
        const subClip = {
            id: "sub_" + Date.now(),
            type: 'subtitle',
            name: "Legendas Auto",
            start: this.project.currentTime, 
            duration: duration,
            offset: 0,
            level: 1, 
            subtitleConfig: config,
            transcriptionData: [
                { start: 0, end: duration, text: "Texto de Exemplo" }
            ],
            transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, maintainAspect: true }
        };

        targetTrack.clips.push(subClip);
        this.timelineManager.renderTracks();
        
        // Abre o modal imediatamente para oferecer transcrição
        this.uiManager.openSubtitleModal(subClip);
    }

    async runSubtitleTranscription(clip, onProgress) {
        const workerUrl = chrome.runtime.getURL('src/workers/whisper.worker.js');
        const worker = new Worker(workerUrl, { type: 'module' });

        return new Promise(async (resolve, reject) => {
            onProgress(5);

            try {
                console.log(`[StudioManager] Iniciando transcrição para clip de ${clip.duration}s`);
                
                // 1. Extração Acelerada de Áudio
                const audioData = await this.extractAudioBuffer(clip.start, clip.duration);
                
                let maxAmplitude = 0;
                for (let i = 0; i < audioData.length; i += 100) { // Amostragem
                    const val = Math.abs(audioData[i]);
                    if (val > maxAmplitude) maxAmplitude = val;
                }
                
                console.log(`[StudioManager] Diagnóstico de Áudio: Max Amplitude = ${maxAmplitude.toFixed(4)}`);

                if (maxAmplitude < 0.001) {
                    console.warn("[StudioManager] CRÍTICO: O áudio extraído é SILÊNCIO. O Whisper vai alucinar.");
                    this.uiManager.showToast("Erro: O trecho selecionado está mudo.");
                    worker.terminate();
                    return resolve();
                }

                onProgress(20);

                // 2. Envia para o Worker
                worker.postMessage({
                    type: 'transcribe',
                    audio: audioData,
                    language: 'portuguese'
                });

                worker.onmessage = (e) => {
                    const { status, data, output, error } = e.data;

                    if (status === 'loading') {
                        if (data.status === 'progress' && data.total) {
                            const percent = (data.loaded / data.total) * 100;
                            // Calcula progresso visual
                            const uiProgress = 20 + (percent * 0.4);
                            onProgress(uiProgress);
                        }
                    } 
                    else if (status === 'complete') {
                        console.log("[StudioManager] Transcrição recebida:", output);
                        
                        const segments = output.chunks.map(chunk => ({
                            start: chunk.timestamp[0],
                            end: chunk.timestamp[1] || (chunk.timestamp[0] + 2),
                            text: chunk.text.trim()
                        }));

                        clip.transcriptionData = segments;
                        onProgress(100);
                        this.timelineManager.renderTracks();
                        this.uiManager.showToast("Transcrição concluída!");
                        this.playbackManager.seekAndRender(clip.start);
                        worker.terminate();
                        resolve();
                    } 
                    else if (status === 'error') {
                        console.error("[StudioManager] Erro no Worker:", error);
                        worker.terminate();
                        reject(new Error(error));
                    }
                };

            } catch (err) {
                console.error("[StudioManager] Erro fatal:", err);
                worker.terminate();
                reject(err);
            }
        });
    }

    /**
     * Renderiza o áudio da timeline em memória (OfflineAudioContext)
     * para ser enviado ao Whisper. Muito mais rápido que realtime.
     */
    async extractAudioBuffer(startTime, duration) {
        console.log(`[AudioExtract] Iniciando renderização: Start=${startTime.toFixed(2)}, Dur=${duration.toFixed(2)}s`);
        
        const sampleRate = 16000; 
        const offlineCtx = new OfflineAudioContext(1, Math.ceil(sampleRate * duration), sampleRate);
        
        const decodeCtx = new AudioContext(); 

        let clipsProcessed = 0;
        let clipsFound = 0;

        try {
            // Itera sobre todas as tracks
            for (const track of this.project.tracks) {
                if (track.muted) {
                    console.log(`[AudioExtract] Pulando track mutada: ${track.name}`);
                    continue;
                }
                
                // Filtra clipes que tocam durante o intervalo da legenda
                const clips = track.clips.filter(c => 
                    (c.start + c.duration) > startTime && c.start < (startTime + duration)
                );

                for (const clip of clips) {
                    // Pula legendas e imagens (não têm áudio)
                    if (clip.type === 'subtitle' || clip.type === 'image') continue;

                    const asset = this.project.assets.find(a => a.id === clip.assetId);
                    if (!asset) {
                        console.warn(`[AudioExtract] Asset não encontrado para o clip: ${clip.name}`);
                        continue;
                    }

                    clipsFound++;
                    let sourceBuffer = asset.audioBufferCache;

                    // Se não estiver em cache, tenta decodificar
                    if (!sourceBuffer) {
                        if (!asset.sourceBlob) {
                            console.error(`[AudioExtract] ERRO CRÍTICO: 'sourceBlob' é nulo para o asset '${asset.name}'. O áudio não pode ser carregado.`);
                            // Tentar fallback via URL se existir
                            if (asset.url) {
                                try {
                                    console.log(`[AudioExtract] Tentando recuperar via fetch URL: ${asset.url}`);
                                    const resp = await fetch(asset.url);
                                    const arrayBuffer = await resp.arrayBuffer();
                                    sourceBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
                                    asset.audioBufferCache = sourceBuffer;
                                } catch(err) {
                                    console.error(`[AudioExtract] Falha no fallback de URL:`, err);
                                    continue;
                                }
                            } else {
                                continue;
                            }
                        } else {
                            try {
                                console.log(`[AudioExtract] Decodificando Blob do asset: ${asset.name}`);
                                const arrayBuffer = await asset.sourceBlob.arrayBuffer();
                                // Usa o decodeCtx compartilhado
                                sourceBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
                                asset.audioBufferCache = sourceBuffer; 
                            } catch(e) {
                                console.error(`[AudioExtract] Falha ao decodificar ${asset.name}:`, e);
                                continue;
                            }
                        }
                    }

                    // Validação final do buffer
                    if (!sourceBuffer) {
                        console.warn(`[AudioExtract] Buffer de áudio vazio para ${asset.name}`);
                        continue;
                    }

                    // Cria o nó de áudio no contexto Offline
                    const source = offlineCtx.createBufferSource();
                    source.buffer = sourceBuffer;

                    // --- CÁLCULO DE CORTE (TRIMMING) ---
                    
                    // 1. Quando o clip começa dentro do "buffer de saída"? 
                    // (0 = inicio da legenda)
                    const bufferStartOffset = Math.max(0, clip.start - startTime);

                    // 2. De onde começar a ler o arquivo original?
                    // (Offset do clip + pedaço que já passou antes da legenda começar)
                    let assetReadStart = clip.offset;
                    if (clip.start < startTime) {
                        assetReadStart += (startTime - clip.start);
                    }

                    // 3. Quanto tempo tocar?
                    let durationToPlay = clip.duration;
                    // Se cortou o começo
                    if (clip.start < startTime) {
                        durationToPlay -= (startTime - clip.start);
                    }
                    // Se cortar o final (vai além da legenda)
                    if ((bufferStartOffset + durationToPlay) > duration) {
                        durationToPlay = duration - bufferStartOffset;
                    }

                    if (durationToPlay > 0) {
                        source.connect(offlineCtx.destination);
                        source.start(bufferStartOffset, assetReadStart, durationToPlay);
                        clipsProcessed++;
                        console.log(`[AudioExtract] Agendado: ${asset.name} | Start: ${bufferStartOffset.toFixed(2)}s | Offset: ${assetReadStart.toFixed(2)}s | Dur: ${durationToPlay.toFixed(2)}s`);
                    }
                }
            }
        } finally {
            decodeCtx.close();
        }

        if (clipsProcessed === 0) {
            console.warn("[AudioExtract] NENHUM clipe de áudio agendado. Resultado será silêncio.");
        }

        // Renderiza
        const renderedBuffer = await offlineCtx.startRendering();
        const channelData = renderedBuffer.getChannelData(0);

        // Verificação final de sinal (Amplitude)
        let maxAmp = 0;
        for(let i=0; i<channelData.length; i+=500) {
            if(Math.abs(channelData[i]) > maxAmp) maxAmp = Math.abs(channelData[i]);
        }
        console.log(`[AudioExtract] Renderização concluída. Amplitude Máxima Detectada: ${maxAmp.toFixed(5)}`);

        return channelData;
    }
}