import { DriveService } from '../services/DriveService.js';
import { VideoStorage } from '../services/VideoStorage.js';
import { TranscodeService } from './transcode.js';
import { StudioManager } from './studio/studio.js';

/**
 * EditorManager
 * Responsável por gerenciar a UI do editor simples, carregar vídeos,
 * realizar cortes, conversões e integrações com o Studio/Drive.
 */
class EditorManager {
    constructor() {
        // Estado do Vídeo Atual
        this.videoBlob = null;
        this.videoUrl = null;
        this.fileName = "";
        this.duration = 0;
        this.currentExtension = "webm"; // Extensão real do arquivo carregado

        // Estado da Aplicação
        this.isProcessing = false;

        // Cache para evitar re-conversão de MP4 se o usuário não alterar o corte
        this.cachedMp4 = {
            blob: null,
            signature: null // Formato: "start_end_tamanho"
        };

        // Serviços
        this.studio = new StudioManager(this);
        this.driveService = new DriveService();
        this.transcoder = new TranscodeService();

        // Mapeamento de Elementos da UI
        this.ui = {
            video: document.getElementById("video-player"),

            // Slider de Timeline
            rangeMin: document.getElementById("range-min"),
            rangeMax: document.getElementById("range-max"),
            rangeFill: document.getElementById("range-fill"),

            // Inputs de Tempo
            startTimeInput: document.getElementById("start-time"),
            endTimeInput: document.getElementById("end-time"),

            // Botões de Ação
            btnCut: document.getElementById("btn-cut"),
            btnDownload: document.getElementById("btn-download"),
            btnDownloadMp4: document.getElementById("btn-download-mp4"),
            btnDownloadGif: document.getElementById("btn-download-gif"),
            btnDrive: document.getElementById("btn-drive"),
            btnOpenStudio: document.getElementById("btn-open-studio"),

            // Overlay de Carregamento
            loader: document.getElementById("processing-overlay"),
            loadingText: document.getElementById("loading-text")
        };
    }

    /**
     * Inicialização da Aplicação
     */
    async init() {
        // Inicializa subsistemas
        this.studio.init();

        // Verifica modo de abertura (ex: ?mode=studio)
        const params = new URLSearchParams(window.location.search);
        const mode = params.get('mode');

        if (mode === 'studio') {
            this._setupListeners();
            this.studio.toggleMode();
            return;
        }

        // Tenta carregar vídeo recém gravado (via ID na URL ou Storage)
        const urlVideoId = params.get('videoId');
        let targetVideoId = urlVideoId;

        if (!targetVideoId) {
            const data = await chrome.storage.local.get(["videoId"]);
            targetVideoId = data.videoId;
        }

        if (!targetVideoId) {
            // Se não tem vídeo, apenas configura listeners (pode ser upload manual no futuro)
            this._setupListeners();
            return alert("Nenhum vídeo encontrado para edição.");
        }

        this.fileName = this._generateFileName();
        this._setLoading(true, "Carregando vídeo...");

        try {
            await this.transcoder.init();
            const storage = new VideoStorage();

            // --- LÓGICA DE RETRY (Evita Race Condition no Save) ---
            // Tenta buscar o vídeo 5 vezes (total 2.5s) antes de desistir
            let videoBlob = null;

            for (let i = 0; i < 5; i++) {
                // Tenta pegar segmentos unificados ou blob único
                const segments = await storage.getVideoSegments(targetVideoId);

                if (segments && segments.length > 0) {
                    console.log(`[Editor] Vídeo encontrado na tentativa ${i + 1}.`);

                    if (segments.length > 1) {
                        this._setLoading(true, "Unindo segmentos...");
                        const mergedUrl = await this.transcoder.mergeSegments(segments, "merged_video");
                        const resp = await fetch(mergedUrl);
                        videoBlob = await resp.blob();
                    } else {
                        videoBlob = segments[0];
                    }
                    break;
                }

                console.log(`[Editor] Aguardando vídeo (Tentativa ${i + 1})...`);
                await new Promise(r => setTimeout(r, 500));
            }

            if (!videoBlob || videoBlob.size === 0) {
                throw new Error("O arquivo de vídeo não foi encontrado ou está vazio.");
            }

            this.videoBlob = videoBlob;
            const url = URL.createObjectURL(this.videoBlob);

            await this._loadVideo(url);
            this._setupListeners();

        } catch (error) {
            console.error("[Editor] Erro fatal no init:", error);
            alert("Erro ao carregar editor: " + error.message);
        } finally {
            this._setLoading(false);
        }
    }

    /**
     * Configura todos os Event Listeners da UI.
     */
    _setupListeners() {
        if (this.ui.rangeMin) {
            const newMin = this.ui.rangeMin.cloneNode(true);
            this.ui.rangeMin.parentNode.replaceChild(newMin, this.ui.rangeMin);
            this.ui.rangeMin = newMin;

            this.ui.rangeMin.addEventListener("input", () => this._updateSlider("min"));
        }

        if (this.ui.rangeMax) {
            const newMax = this.ui.rangeMax.cloneNode(true);
            this.ui.rangeMax.parentNode.replaceChild(newMax, this.ui.rangeMax);
            this.ui.rangeMax = newMax;

            this.ui.rangeMax.addEventListener("input", () => this._updateSlider("max"));
        }

        // Ações Principais
        if (this.ui.btnCut) this.ui.btnCut.addEventListener("click", () => this._handleCut());

        if (this.ui.btnDownload) {
            this.ui.btnDownload.addEventListener("click", () => {
                // Baixa no formato atual (geralmente WebM)
                if (this.videoBlob) this._triggerDownload(this.videoBlob, this.currentExtension);
            });
        }

        // Lógica Inteligente de MP4 (Cache/Conversão)
        if (this.ui.btnDownloadMp4) {
            // Remove listeners antigos (cloneNode hack) para garantir limpeza
            const newBtn = this.ui.btnDownloadMp4.cloneNode(true);
            this.ui.btnDownloadMp4.parentNode.replaceChild(newBtn, this.ui.btnDownloadMp4);
            this.ui.btnDownloadMp4 = newBtn;

            this.ui.btnDownloadMp4.addEventListener("click", () => this._handleConvertAndDownloadMP4());
        }

        if (this.ui.btnDownloadGif) this.ui.btnDownloadGif.addEventListener("click", () => this._handleConvertAndDownloadGif());

        if (this.ui.btnDrive) this.ui.btnDrive.addEventListener("click", () => this._handleDriveUpload());

        // Alternar para Studio
        if (this.ui.btnOpenStudio) this.ui.btnOpenStudio.addEventListener("click", () => this.studio.toggleMode());
    }

    /**
     * Carrega um vídeo no player e reinicia a UI.
     */
    async _loadVideo(url) {
        if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
        this.videoUrl = url;

        // Limpa cache MP4 pois o vídeo base mudou
        this.resetCache();

        if (this.ui.video) {
            this.ui.video.src = url;
            return new Promise((resolve) => {
                this.ui.video.onloadedmetadata = async () => {
                    if (this.ui.video.duration === Infinity) {
                        this.duration = await this._fixVideoDuration(this.ui.video);
                    } else {
                        this.duration = this.ui.video.duration;
                    }

                    // Reseta controles de tempo
                    this._updateRangeUI(0, this.duration);
                    this._enableButtons();
                    resolve();
                };

                this.ui.video.onerror = (e) => {
                    console.error("[Editor] Erro no Player:", this.ui.video.error);
                    resolve();
                };
            });
        }
    }

    /**
     * Limpa o cache de conversão MP4.
     */
    resetCache() {
        this.cachedMp4 = { blob: null, signature: null };
    }

    // --- LÓGICA DE EVENTOS ---

    async _handleCut() {
        if (this.isProcessing) return;
        this._setLoading(true, "Iniciando corte...");

        try {
            const startSec = this._timeToSeconds(this.ui.startTimeInput.value);
            const endSec = this._timeToSeconds(this.ui.endTimeInput.value);
            const duration = endSec - startSec;

            if (duration <= 0) throw new Error("Duração inválida.");

            const newVideoUrl = await this.transcoder.processVideo(
                this.videoBlob,
                this.fileName,
                startSec,
                duration,
                "webm",
                {}, 
                (prog) => {
                    const pct = Math.floor(prog.percent * 100);
                    this._setLoading(true, `Cortando vídeo... ${pct}%`);
                }
            );

            const resp = await fetch(newVideoUrl);
            this.videoBlob = await resp.blob();
            this.currentExtension = "webm";

            await this._loadVideo(newVideoUrl);
            
            this._resetSlider();

        } catch (error) {
            console.error(error);
            alert("Erro ao cortar: " + error.message);
        } finally {
            this._setLoading(false, "");
        }
    }

    async _handleConvertAndDownloadMP4() {
        if (this.isProcessing || !this.videoBlob) return;

        const start = this._timeToSeconds(this.ui.startTimeInput.value) || 0;
        const end = this._timeToSeconds(this.ui.endTimeInput.value) || this.duration;
        const duration = end - start;

        // Verifica se o usuário quer o vídeo inteiro (sem cortes na UI)
        const isFullVideo = (Math.abs(start) < 0.1 && Math.abs(end - this.duration) < 0.1);
        
        // CASO 1: O vídeo atual JÁ É MP4 (ex: veio do Studio convertido)
        if (this.currentExtension === 'mp4' && isFullVideo) {
            console.log("[Editor] Vídeo já é MP4. Baixando direto.");
            this._triggerDownload(this.videoBlob, 'mp4');
            return;
        }

        // CASO 2: Já convertemos esse mesmo trecho antes? (Cache Hit)
        // Assinatura única baseada no trecho e no tamanho do arquivo original
        const currentSignature = `${start.toFixed(2)}_${duration.toFixed(2)}_${this.videoBlob.size}`;
        
        if (this.cachedMp4.blob && this.cachedMp4.signature === currentSignature) {
            console.log("[Editor] Usando MP4 em cache.");
            this._triggerDownload(this.cachedMp4.blob, 'mp4');
            return;
        }

        // CASO 3: Precisa converter (Fallback Transcoder)
        try {
            this._setLoading(true, "Convertendo para MP4 (Isso pode demorar)...");
            
            // Chama o transcoder com o callback de progresso
            const mp4Url = await this.transcoder.processVideo(
                this.videoBlob, 
                this.fileName, 
                start, 
                duration, 
                'mp4',
                {}, // options
                (prog) => {
                    const pct = Math.floor(prog.percent * 100);
                    this._setLoading(true, `Convertendo para MP4... ${pct}%`);
                }
            );

            const res = await fetch(mp4Url);
            const mp4Blob = await res.blob();

            // Salva no Cache para o próximo clique
            this.cachedMp4 = {
                blob: mp4Blob,
                signature: currentSignature
            };

            this._triggerDownload(mp4Url, "mp4");

        } catch (error) {
            console.error(error);
            alert("Erro ao converter MP4: " + error.message);
        } finally {
            this._setLoading(false, "");
        }
    }

    async _handleConvertAndDownloadGif() {
        if (this.isProcessing) return;
        this._setLoading(true, "Gerando GIF...");

        try {
            const startSec = this._timeToSeconds(this.ui.startTimeInput.value);
            const endSec = this._timeToSeconds(this.ui.endTimeInput.value);
            const duration = endSec - startSec;

            const gifUrl = await this.transcoder.processVideo(
                this.videoBlob,
                this.fileName,
                startSec, 
                duration, 
                "gif",
                {},
                (prog) => {
                    const pct = Math.floor(prog.percent * 100);
                    const extraText = duration > 10 ? "(Timelapse)" : "";
                    this._setLoading(true, `Gerando GIF ${extraText}... ${pct}%`);
                }
            );

            this._triggerDownload(gifUrl, "gif");

        } catch (error) {
            console.error(error);
            alert("Erro ao criar GIF: " + error.message);
        } finally {
            this._setLoading(false, "");
        }
    }

    async _handleDriveUpload() {
        if (this.isProcessing) return;
        this._setLoading(true, "Iniciando upload...");
        
        try {
            const auth = await chrome.runtime.sendMessage({ action: "get_auth_token" });
            if (!auth || !auth.token) throw new Error("Falha na autenticação do Google.");

            const filename = `${this.fileName}.${this.currentExtension}`;
            
            const res = await this.driveService.uploadVideoWithToken(
                auth.token, 
                this.videoBlob, 
                filename,
                (prog) => {
                    const pct = Math.floor(prog.percent * 100);
                    this._setLoading(true, `Enviando para o Drive... ${pct}%`);
                }
            );

            if (res.fileViewLink) window.open(res.fileViewLink);
            else alert("Upload concluído!");

        } catch (e) {
            alert("Erro no upload: " + e.message);
        } finally {
            this._setLoading(false);
        }
    }

    // --- HELPERS DE UI E UTILITÁRIOS ---

    _triggerDownload(content, ext) {
        let url;
        // Se for Blob, cria URL. Se for string, usa direto.
        if (content instanceof Blob) {
            url = URL.createObjectURL(content);
        } else {
            url = content;
        }

        if (!this.fileName || this.fileName.trim() === "") {
            this.fileName = this._generateFileName();
        }

        const a = document.createElement("a");
        a.href = url;
        a.download = `${this.fileName}.${ext}`;
        a.style.display = "none";

        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            a.remove();
            if (content instanceof Blob) URL.revokeObjectURL(url);
        }, 100);
    }

    /**
     * Atualiza visualmente os sliders e inputs com base nos valores de tempo (segundos).
     * Usado ao carregar vídeo ou resetar.
     */
    _updateRangeUI(startSec, endSec) {
        if (!this.duration || this.duration <= 0) return;

        // Converte segundos para porcentagem (0-100) para os sliders HTML
        const startPct = (startSec / this.duration) * 100;
        const endPct = (endSec / this.duration) * 100;

        // Atualiza os sliders (input range)
        if (this.ui.rangeMin) {
            this.ui.rangeMin.min = 0;
            this.ui.rangeMin.max = 100;
            this.ui.rangeMin.value = startPct;
        }
        if (this.ui.rangeMax) {
            this.ui.rangeMax.min = 0;
            this.ui.rangeMax.max = 100;
            this.ui.rangeMax.value = endPct;
        }

        // Atualiza inputs de texto e barra visual
        this._updateTimeInputs(startSec, endSec);
        this._renderSliderFill();
    }

    /**
     * Reseta explicitamente o slider para 0-100%.
     * Útil após um corte para indicar que agora o vídeo inteiro (novo) está selecionado.
     */
    _resetSlider() {
        if (this.ui.rangeMin) this.ui.rangeMin.value = 0;
        if (this.ui.rangeMax) this.ui.rangeMax.value = 100;
        this._renderSliderFill();
        this._updateTimeInputs(0, this.duration);
    }

    _updateTimeInputs(startSec, endSec) {
        if (this.ui.startTimeInput) this.ui.startTimeInput.value = this._formatTime(startSec);
        if (this.ui.endTimeInput) this.ui.endTimeInput.value = this._formatTime(endSec);
    }

    _renderSliderFill() {
        if (!this.ui.rangeMin || !this.ui.rangeMax || !this.ui.rangeFill) return;

        const minVal = parseFloat(this.ui.rangeMin.value);
        const maxVal = parseFloat(this.ui.rangeMax.value);

        // Garante limites 0-100
        const safeMin = Math.max(0, Math.min(100, minVal));
        const safeMax = Math.max(0, Math.min(100, maxVal));

        this.ui.rangeFill.style.left = `${safeMin}%`;
        this.ui.rangeFill.style.width = `${safeMax - safeMin}%`;
    }

    _updateSlider(source) {
        const minVal = parseFloat(this.ui.rangeMin.value);
        const maxVal = parseFloat(this.ui.rangeMax.value);
        const gap = 1; // Gap mínimo de 1% para evitar sobreposição

        if (source === "min") {
            if (maxVal - minVal < gap) {
                this.ui.rangeMin.value = maxVal - gap;
            }
        } else {
            if (maxVal - minVal < gap) {
                this.ui.rangeMax.value = minVal + gap;
            }
        }

        this._renderSliderFill();

        // Calcula tempo real para mostrar nos inputs
        const currentStartPct = parseFloat(this.ui.rangeMin.value);
        const currentEndPct = parseFloat(this.ui.rangeMax.value);

        const startSec = (currentStartPct / 100) * this.duration;
        const endSec = (currentEndPct / 100) * this.duration;

        this._updateTimeInputs(startSec, endSec);

        // Seek no vídeo para feedback visual
        if (source === "min") {
            this.ui.video.currentTime = startSec;
        } else {
            this.ui.video.currentTime = endSec;
        }
    }

    _updateRangeFill() {
        if (!this.ui.rangeMin || !this.ui.rangeMax || !this.ui.rangeFill) return;

        const minVal = parseFloat(this.ui.rangeMin.value);
        const maxVal = parseFloat(this.ui.rangeMax.value);
        const total = this.duration > 0 ? this.duration : 1;

        const leftPct = (minVal / total) * 100;
        const widthPct = ((maxVal - minVal) / total) * 100;

        this.ui.rangeFill.style.left = `${leftPct}%`;
        this.ui.rangeFill.style.width = `${widthPct}%`;
    }

    _fixVideoDuration(videoElement) {
        return new Promise((resolve) => {
            videoElement.currentTime = 1e101;
            videoElement.ontimeupdate = () => {
                videoElement.ontimeupdate = null;
                videoElement.currentTime = 0;
                resolve(videoElement.duration);
            };
        });
    }

    _setLoading(active, text) {
        this.isProcessing = active;
        if (this.ui.loadingText) this.ui.loadingText.innerText = text || "Carregando...";
        if (this.ui.loader) this.ui.loader.style.display = active ? "flex" : "none";

        [this.ui.btnCut, this.ui.btnDownload, this.ui.btnDownloadMp4, this.ui.btnDownloadGif, this.ui.btnDrive].forEach(b => {
            if (b) b.disabled = active;
        });
    }

    _enableButtons() {
        [this.ui.btnCut, this.ui.btnDownload, this.ui.btnDownloadMp4, this.ui.btnDownloadGif, this.ui.btnDrive].forEach(b => {
            if (b) b.disabled = false;
        });
    }

    _generateFileName() {
        const now = new Date();
        const date = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
        const time = now.toTimeString().slice(0, 5).replace(":", "-"); // HH-MM
        return `solutto-recorder-${date}_${time}`;
    }

    /**
     * Formata segundos para HH:MM:SS;FF (Frames)
     * Baseado em 30 FPS fixo.
     */
    _formatTime(s) {
        if (!Number.isFinite(s)) return "00:00:00;00";

        const fps = 30; // Fixo conforme solicitado

        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);

        // Pega a parte decimal dos segundos e converte para frames
        // Ex: 0.5s * 30fps = 15 frames
        const frames = Math.floor((s % 1) * fps);

        const pad = (n) => n.toString().padStart(2, '0');

        // Retorna formato com ponto e vírgula para frames (padrão SMPTE drop-frame-ish)
        return `${pad(h)}:${pad(m)}:${pad(sec)};${pad(frames)}`;
    }

    /**
     * Converte HH:MM:SS;FF de volta para segundos precisos (float).
     */
    _timeToSeconds(str) {
        // Aceita separadores : ou ; (ex: 00:00:05;15)
        const parts = str.split(/[:;]/).map(Number);

        let h = 0, m = 0, s = 0, f = 0;
        const fps = 30;

        if (parts.length >= 4) {
            [h, m, s, f] = parts;
        } else if (parts.length === 3) {
            // Fallback para formato antigo (sem frames)
            [h, m, s] = parts;
        }

        // Reconstrói o tempo total somando a fração dos frames
        return (h * 3600) + (m * 60) + s + (f / fps);
    }
}

// Inicializa quando o DOM estiver pronto
document.addEventListener("DOMContentLoaded", () => {
    const e = new EditorManager();
    e.init();
});