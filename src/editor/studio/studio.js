import { UIManager } from './managers/UIManager.js';
import { AssetManager } from './managers/AssetManager.js';
import { TimelineManager } from './managers/TimelineManager.js';
import { PlaybackManager } from './managers/PlaybackManager.js';
import { RenderManager } from './managers/RenderManager.js';
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
            let inferenceInterval = null;

            const cleanup = () => {
                if (inferenceInterval) clearInterval(inferenceInterval);
                worker.terminate();
            };

            worker.onerror = (err) => {
                console.error("[StudioManager] Erro fatal no Worker:", err);
                cleanup();
                reject(new Error("Falha ao iniciar o processador de áudio."));
            };

            onProgress(5);

            try {
                console.log(`[StudioManager] Iniciando transcrição. Duração: ${clip.duration.toFixed(2)}s`);
                
                // Fase 2: Extração de Áudio (5% -> 20%)
                const audioData = await this.extractAudioBuffer(clip.start, clip.duration);
                
                let maxAmplitude = 0;
                for (let i = 0; i < audioData.length; i += 100) { 
                    const val = Math.abs(audioData[i]);
                    if (val > maxAmplitude) maxAmplitude = val;
                }
                
                if (maxAmplitude < 0.001) {
                    this.uiManager.showToast("Aviso: O trecho selecionado está mudo.");
                    cleanup();
                    return resolve(); 
                }

                onProgress(20); 

                worker.postMessage({
                    type: 'transcribe',
                    audio: audioData,
                    language: 'portuguese'
                });

                worker.onmessage = (e) => {
                    const { status, data, output, error } = e.data;

                    if (status === 'loading') {
                        if (data.status === 'progress' && data.total) {
                            const percent = (data.loaded / data.total);
                            const uiProgress = 20 + (percent * 40); // Mapeia para 20-60%
                            onProgress(uiProgress);
                        }
                        else if (data.status === 'done' || data.status === 'ready') {
                            onProgress(60);
                            
                            if (!inferenceInterval) {
                                let fakeProgress = 60;
                                const step = 0.5; 
                                inferenceInterval = setInterval(() => {
                                    fakeProgress += step;
                                    if (fakeProgress > 95) fakeProgress = 95; 
                                    onProgress(fakeProgress);
                                }, 100);
                            }
                        }
                    } 
                    else if (status === 'complete') {
                        if (inferenceInterval) clearInterval(inferenceInterval);
                        onProgress(100);

                        console.log("[StudioManager] Transcrição concluída.");
                        
                        const segments = output.chunks.map(chunk => ({
                            start: chunk.start,
                            end: chunk.end,
                            text: chunk.text.trim()
                        }));

                        clip.transcriptionData = segments;
                        this.timelineManager.renderTracks();
                        this.uiManager.showToast("Transcrição concluída!");
                        
                        this.playbackManager.seekAndRender(clip.start);
                        
                        cleanup();
                        resolve();
                    } 
                    else if (status === 'error') {
                        console.error("[StudioManager] Erro no Worker:", error);
                        cleanup();
                        reject(new Error(error));
                    }
                };

            } catch (err) {
                console.error("[StudioManager] Erro no fluxo principal:", err);
                cleanup();
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

    async retranscribeClipGap(clip) {
        if (!clip.needsTranscription) return;

        // 1. Encontra a última palavra válida para saber onde começar
        const lastWord = clip.transcriptionData[clip.transcriptionData.length - 1];
        const existingEndTime = lastWord ? lastWord.end : 0;
        
        // Onde termina o clipe agora (no tempo do asset)
        const newEndTime = clip.offset + clip.duration;
        
        // Se não há lacuna real, cancela
        if (newEndTime <= existingEndTime) {
            clip.needsTranscription = false;
            this.timelineManager.renderTracks();
            return;
        }

        // 2. Prepara UI
        const originalText = document.querySelector(`.clip[data-clip-id="${clip.id}"] .clip-name`).innerText;
        this.setLoading(true, "Transcrevendo trecho novo...");
        
        // 3. Obtém o Asset de Áudio/Vídeo Original
        const asset = this.project.assets.find(a => a.id === clip.assetId);
        if (!asset) return;

        // 4. Recorta o áudio APENAS da parte nova
        // Precisamos do AudioContext para decodificar e cortar
        const audioCtx = this.timelineManager.audioContext;
        let fullBuffer = asset.audioBufferCache; // Assumindo que já temos cache
        
        if (!fullBuffer && asset.sourceBlob) {
            // Fallback: decodifica se não tiver cache
            const arrayBuffer = await asset.sourceBlob.arrayBuffer();
            fullBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        }

        if (fullBuffer) {
            const sampleRate = fullBuffer.sampleRate;
            // Margem de segurança de 0.1s antes para não cortar fonema
            const startFrame = Math.floor(Math.max(0, existingEndTime - 0.1) * sampleRate); 
            const endFrame = Math.floor(newEndTime * sampleRate);
            const frameCount = endFrame - startFrame;

            if (frameCount > 0) {
                const cutBuffer = audioCtx.createBuffer(1, frameCount, sampleRate);
                // Copia canal 0 (mono é suficiente para transcrição)
                const channelData = fullBuffer.getChannelData(0);
                const cutData = cutBuffer.getChannelData(0);
                
                for (let i = 0; i < frameCount; i++) {
                    if (startFrame + i < channelData.length) {
                        cutData[i] = channelData[startFrame + i];
                    }
                }

                // 5. Envia para o Worker
                const worker = new Worker('whisper.worker.js', { type: "module" });
                
                worker.postMessage({
                    type: 'transcribe',
                    audio: cutData, // Envia Float32Array
                    language: 'portuguese',
                    offsetCorrection: Math.max(0, existingEndTime - 0.1) 
                });

                worker.onmessage = (e) => {
                    const { status, output } = e.data;

                    if (status === 'loading') {
                        // Atualiza barra de progresso se houver
                        if (this.setLoadingProgress) this.setLoadingProgress(output.progress);
                    } 
                    else if (status === 'complete') {
                        console.log("[StudioManager] Transcrição concluída:", output);

                        // Passamos o array de chunks (que contém as palavras) para o processador
                        if (output.chunks && output.chunks.length > 0) {
                            // Se você cria uma track nova antes, use o ID dela.
                            const targetTrackId = this.ensureSubtitleTrackExists(); 
                            
                            this.processTranscriptionToClips(output.chunks, targetTrackId);
                        }

                        if (this.setLoading) this.setLoading(false);
                        worker.terminate();
                    } 
                    else if (status === 'error') {
                        console.error("Erro na transcrição:", e.data.error);
                        if (this.setLoading) this.setLoading(false);
                        worker.terminate();
                    }
                };
            }
        }
    }

    /**
     * Gerencia o estado de carregamento manual na barra de status.
     * @param {boolean} isActive - Se deve mostrar ou esconder o loading.
     * @param {string} message - Mensagem a ser exibida.
     */
    setLoading(isActive, message = "Processando...") {
        const loadingId = 'manual_loading_state';
        
        if (isActive) {
            this.tasks = this.tasks.filter(t => t.id !== loadingId);
            this.tasks.push({ id: loadingId, label: message });
        } else {
            this.tasks = this.tasks.filter(t => t.id !== loadingId);
        }
        
        if (this.uiManager) {
            this.uiManager.updateStatusBar(this.tasks);
        }
    }

    /**
     * Atualiza a porcentagem de progresso na barra de status.
     * @param {number} percent - Valor de 0 a 100.
     */
    setLoadingProgress(percent) {
        this.setLoading(true, `Processando... ${Math.floor(percent)}%`);
    }

    /**
     * Processa o output do Worker (Palavras) e cria Clipes de Legenda agrupados na Timeline.
     * @param {Array} words - O array 'output.chunks' vindo do worker
     * @param {string} trackId - ID da track de legendas
     */
    processTranscriptionToClips(words, trackId) {
        if (!words || words.length === 0) return;

        const MAX_CHARS_PER_SEGMENT = 40; // Máximo de caracteres por linha
        const MAX_SILENCE_GAP = 0.5;      // Pausa > 0.5s força nova legenda
        
        let currentSegmentWords = [];
        let currentSegmentTextLength = 0;
        
        // Função auxiliar para criar o clipe na timeline
        const createClipFromSegment = (segmentWords) => {
            if (segmentWords.length === 0) return;

            const firstWord = segmentWords[0];
            const lastWord = segmentWords[segmentWords.length - 1];
            
            // Texto visual para o clipe (frase completa)
            const fullText = segmentWords.map(w => w.text).join(" ");

            // Cria o objeto do clipe
            const clipData = {
                id: "clip_" + Date.now() + Math.random().toString(36).substr(2, 5),
                assetId: null, // Asset virtual
                start: firstWord.start,
                duration: lastWord.end - firstWord.start,
                offset: 0,
                type: 'subtitle',
                name: fullText,
                transcriptionData: segmentWords, // Guarda as palavras individuais para o efeito Karaoke
                subtitleConfig: {
                    font: 'Arial',
                    size: 40,
                    color: '#ffffff',
                    highlightColor: '#ffff00', // Cor do destaque Karaoke
                    bgColor: 'rgba(0,0,0,0.5)',
                    bold: true
                }
            };
            
            // Adiciona à track via TimelineManager
            const track = this.timelineManager.studio.project.tracks.find(t => t.id === trackId);
            if (track) {
                track.clips.push(clipData);
            }
        };

        // Algoritmo de Agrupamento
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const prevWord = words[i-1];
            
            // 1. Detecta Silêncio Grande entre palavras
            const isBigGap = prevWord && (word.start - prevWord.end > MAX_SILENCE_GAP);
            
            // 2. Detecta Tamanho Máximo da frase
            const willExceedLength = (currentSegmentTextLength + word.text.length) > MAX_CHARS_PER_SEGMENT;

            if ((isBigGap || willExceedLength) && currentSegmentWords.length > 0) {
                createClipFromSegment(currentSegmentWords);
                currentSegmentWords = [];
                currentSegmentTextLength = 0;
            }

            currentSegmentWords.push(word);
            currentSegmentTextLength += word.text.length + 1; 
        }

        // Cria o último segmento que sobrou no buffer
        if (currentSegmentWords.length > 0) {
            createClipFromSegment(currentSegmentWords);
        }

        // Atualiza a UI
        this.timelineManager.renderTracks();
        this.timelineManager.studio.markUnsavedChanges();
    }

    ensureSubtitleTrackExists() {
        let track = this.timelineManager.studio.project.tracks.find(t => t.type === 'subtitle'); // Ou use uma lógica específica
        if (!track) {
            track = this.timelineManager.studio.project.tracks.find(t => t.type === 'video');
            if(!track) {
                this.timelineManager.studio.addTrack('video');
                track = this.timelineManager.studio.project.tracks[this.timelineManager.studio.project.tracks.length-1];
            }
        }
        return track.id;
    }
}