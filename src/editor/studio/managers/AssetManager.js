import { getMediaDuration } from '../utils.js';
import { VideoStorage } from '../../../services/VideoStorage.js';

export class AssetManager {
    constructor(studio) {
        this.studio = studio;
        this.videoStorage = new VideoStorage();
    }

    init() {
        this.renderBin();
    }

    async importAsset(file, name = "Sem Nome") {
        const mime = file.type ? file.type.split('/')[0] : 'video';
        const type = mime === 'image' ? 'image' : mime; 
        
        const assetId = "asset_" + Date.now();
        
        const placeholder = {
            id: assetId,
            name: (type === 'image' ? "[IMG] " : "") + name,
            type: type === 'image' ? 'image' : (mime === 'image' ? 'video' : mime), 
            originalType: mime,
            blob: null, 
            sourceBlob: null,
            url: "", 
            baseDuration: 5, 
            status: 'processing'
        };

        this.studio.project.assets.push(placeholder);
        this.renderBin();

        this.studio.addTask(`Processando ${name}.`, async () => {
            const result = await this._createAsset(file, name, mime);
            const idx = this.studio.project.assets.findIndex(a => a.id === assetId);
            if (idx !== -1) {
                const newAsset = { 
                    ...result, 
                    id: assetId, 
                    status: 'ready', 
                    sourceBlob: file, 
                    originalType: mime 
                };
                
                await this.indexAssetVisuals(newAsset);
                
                this.studio.project.assets[idx] = newAsset;
                this.renderBin();
                this.studio.timelineManager.renderTracks();
            }
        });

        this.studio.markUnsavedChanges();
    }

    async _createAsset(file, name, mimeOverride) {
        let type; let duration; 
        let blob = new Blob([file], { type: file.type });
        const mime = mimeOverride || file.type.split('/')[0];

        if (mime === 'image') {
            type = 'image'; 
            name = "[IMG] " + name;
            const url = URL.createObjectURL(file);
            duration = 5;
            
            return { blob, name, type, baseDuration: duration, url };
        } 
        else if (mime === 'video' || mime === 'application') {
            type = 'video'; duration = await getMediaDuration(blob);
        } else if (mime === 'audio') {
            type = 'audio'; duration = await getMediaDuration(blob);
        }
        
        this.studio.markUnsavedChanges();
        
        if (duration < 0.1) duration = 10; 
        return { blob, name, type, baseDuration: duration, url: URL.createObjectURL(blob) };
    }

    // =========================================================
    // PERSISTÊNCIA: PREPARA OS DADOS PARA SEREM SALVOS
    // =========================================================

    /**
     * Retorna a lista de assets, excluindo objetos de memória (Blobs, AudioBuffers)
     * e incluindo o cache serializável (_frameCache).
     * @returns {Array} Array de objetos Asset prontos para salvar.
     */
    async getSerializableAssets() {
        return Promise.all(this.studio.project.assets.map(async (asset) => {
            // Salva o Blob principal no VideoStorage
            if (asset.sourceBlob) {
                await this.videoStorage.saveVideo(asset.id, asset.sourceBlob);
            }

            // Serializa o _frameCache (convertendo Data URLs se necessário)
            let serializableFrameCache = null;
            if (asset._frameCache && typeof asset._frameCache === 'object') {
                serializableFrameCache = { ...asset._frameCache };
            }

            // Remove propriedades não serializáveis
            return {
                id: asset.id,
                name: asset.name,
                type: asset.type,
                baseDuration: asset.baseDuration,
                originalType: asset.originalType,
                status: asset.status,
                _frameCache: serializableFrameCache,
                // NÃO salva: blob, sourceBlob, url, _waveformBaseCanvas, audioBufferCache, audioWaveCache
            };
        }));
    }

    // =========================================================
    // INDEXAÇÃO (Core Logic)
    // =========================================================

    /**
     * Gera uma cache otimizada de waveform em múltiplos LODs (full, half, quarter, eighth)
     * Retorna um objeto { sampleRate, full, half, quarter, eighth }
     */
    generateOptimizedWaveformCache(audioBuffer) {
        const buildChannelCache = (channelIndex) => {
            const data = audioBuffer.getChannelData(channelIndex);
            const total = data.length;
            
            const build = (bin) => {
                const arr = [];
                for (let i = 0; i < total; i += bin) {
                    let min = 1.0, max = -1.0;

                    for (let j = 0; j < bin && (i + j) < total; j++) {
                        const v = data[i + j];
                        if (v < min) min = v;
                        if (v > max) max = v;
                    }

                    if (min > max) { min = 0; max = 0; }
                    arr.push({ min, max });
                }
                return arr;
            };

            return {
                full: build(1),
                half: build(2),
                quarter: build(4),
                eighth: build(8)
            };
        };

        const result = {
            sampleRate: audioBuffer.sampleRate,
            channels: audioBuffer.numberOfChannels,
            left: buildChannelCache(0) 
        };

        if (audioBuffer.numberOfChannels > 1) {
            result.right = buildChannelCache(1);
        }

        return result;
    }

    /**
     * Gera e armazena frames indexados e audio buffer (cache) no Asset.
     * Isso é a "Indexação" que permite o redimensionamento sem piscar.
     */
    async indexAssetVisuals(asset) {
        const tm = this.studio.timelineManager;

        // Abre AudioContext compartilhado no timelineManager para evitar duplicatas
        if (!tm.audioContext) {
            tm.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        // --- INDEXAÇÃO DE ÁUDIO (Regenerada, pois o buffer não é serializável) ---
        if (asset.type === 'audio' || (asset.type === 'video' && !asset.audioBufferCache)) {
            tm._updateVisualStatus(1);
            try {
                // Tentamos garantir um arrayBuffer mesmo sem sourceBlob (ex: projeto carregado)
                let arrayBuffer = null;

                if (asset.sourceBlob instanceof Blob) {
                    arrayBuffer = await asset.sourceBlob.arrayBuffer();
                } else if (asset.url) {
                    // tenta buscar via URL se disponível (útil quando o asset foi serializado com url)
                    try {
                        const resp = await fetch(asset.url);
                        if (resp.ok) arrayBuffer = await resp.arrayBuffer();
                    } catch (e) {
                        console.warn(`[AssetManager] fetch falhou para ${asset.url}:`, e);
                    }
                }

                if (!arrayBuffer) {
                    // Se não temos arrayBuffer, tentamos reusar cache audioBuffer existente
                    if (asset.audioBufferCache) {
                        // já está indexado
                    } else {
                        console.warn(`[AssetManager] Não foi possível obter blob/url para indexar áudio de ${asset.name}.`);
                    }
                } else {
                    asset.audioBufferCache = await tm.audioContext.decodeAudioData(arrayBuffer);
                    // gera cache otimizado (multi-resolução)
                    try {
                        asset.audioWaveCache = this.generateOptimizedWaveformCache(asset.audioBufferCache);
                    } catch (err) {
                        console.warn("[AssetManager] Falha ao gerar audioWaveCache:", err);
                        asset.audioWaveCache = null;
                    }
                    console.log(`[AssetManager] Audio Buffer e Waveform cache gerados para ${asset.name}`);
                }
            } catch (e) {
                console.error(`Erro ao indexar buffer de áudio para ${asset.name}:`, e);
            } finally {
                tm._updateVisualStatus(-1);
            }
        }

        // --- INDEXAÇÃO DE VÍDEO/IMAGEM (Pulando se o cache existir) ---
        if (asset.type !== 'audio' && (!asset._frameCache || Object.keys(asset._frameCache).length === 0)) {
            tm._updateVisualStatus(1); 
            
            if (asset.type === 'image') {
                asset._frameCache = { '0.0': asset.url }; 
            } else if (asset.type === 'video') {
                const framesPerSecond = 10;
                const duration = asset.baseDuration; 
                
                const video = document.createElement('video');
                video.src = asset.url; 
                video.crossOrigin = 'anonymous';
                video.muted = true;
                
                const frameCache = {};
                
                const capture = (time) => new Promise((resolve) => {
                    video.currentTime = time;
                    video.onseeked = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = 160; canvas.height = 90;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        resolve(canvas.toDataURL());
                    };
                    // fallback timeout
                    setTimeout(() => resolve(null), 1000); 
                });

                try {
                    await new Promise(r => video.onloadedmetadata = r);
                    for (let t = 0; t <= duration; t += 1 / framesPerSecond) {
                        const timeKey = (Math.floor(t * 10) / 10).toFixed(1); 
                        const dataUrl = await capture(t);
                        if (dataUrl) frameCache[timeKey] = dataUrl;
                    }
                    asset._frameCache = frameCache;
                    console.log(`[AssetManager] Indexação de ${asset.name} completa (${Object.keys(frameCache).length} frames).`);
                } catch (e) {
                    console.error(`[AssetManager] Erro indexando frames de vídeo ${asset.name}:`, e);
                }
            }
            tm._updateVisualStatus(-1); 
        }
    }

    async indexAllExistingAssets() {
        console.log("[AssetManager] Verificando assets para re-indexação.");
        const indexingPromises = this.studio.project.assets.map(asset => {
            const needsCache = (asset.type === 'video' || asset.type === 'image');
            // Checa se o cache de frames (serializável) está faltando
            const frameCacheMissing = needsCache && (!asset._frameCache || Object.keys(asset._frameCache).length === 0);
            
            const needsAudioCache = (asset.type === 'audio' || asset.type === 'video');
            const audioCacheMissing = needsAudioCache && !asset.audioBufferCache && !asset.audioWaveCache;

            if (frameCacheMissing || audioCacheMissing) {
                return this.indexAssetVisuals(asset).catch(e => {
                    console.error(`Falha na re-indexação do asset ${asset.name}:`, e);
                });
            }
            return Promise.resolve();
        });

        await Promise.all(indexingPromises);

        console.log("[AssetManager] Re-indexação concluída. Renderizando Tracks.");
        this.studio.timelineManager.renderTracks();
    }

    renderBin() {
        const list = document.getElementById("studio-bin-list");
        if(!list) return;
        list.innerHTML = "";

        const btnAdd = document.createElement("div");
        btnAdd.id = "btn-studio-add";
        btnAdd.className = "bin-item";
        btnAdd.style.justifyContent = "center";
        btnAdd.style.background = "#0078d7"; 
        btnAdd.style.color = "#fff";
        btnAdd.style.cursor = "pointer";
        btnAdd.style.fontWeight = "600";
        
        btnAdd.innerHTML = `
            <i class="fa-solid fa-cloud-arrow-up"></i>
            <span>&nbsp; Importar Mídia</span>
        `;

        btnAdd.onclick = () => {
            const uploadInput = document.getElementById("studio-upload");
            if (uploadInput) uploadInput.click();
        };

        list.appendChild(btnAdd);

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

    getAsset(id) {
        return this.studio.project.assets.find(a => a.id === id);
    }
}