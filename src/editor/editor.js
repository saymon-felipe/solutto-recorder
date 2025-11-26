import { DriveService } from '../services/DriveService.js';
import { VideoStorage } from '../services/VideoStorage.js';
import { TranscodeService } from './transcode.js';

/**
 * EditorManager - Controlador da interface de edição e pós-processamento.
 * Responsável por carregar o vídeo do IndexedDB, gerenciar o player,
 * manipular a timeline de corte (slider) e executar ações de exportação.
 */
class EditorManager {
    constructor() {
        this.videoBlob = null;
        this.videoUrl = null;
        this.fileName = "";
        this.duration = 0;
        this.isProcessing = false;
        
        // Estado do formato atual (começa sempre webm vindo do gravador)
        this.currentExtension = "webm"; 

        // Instancia os serviços
        this.driveService = new DriveService();
        this.transcoder = new TranscodeService();

        this.ui = {
            video: document.getElementById("video-player"),
            rangeMin: document.getElementById("range-min"),
            rangeMax: document.getElementById("range-max"),
            rangeFill: document.getElementById("range-fill"),
            startTimeInput: document.getElementById("start-time"),
            endTimeInput: document.getElementById("end-time"),
            
            btnCut: document.getElementById("btn-cut"),
            btnDownload: document.getElementById("btn-download"),
            btnDownloadMp4: document.getElementById("btn-download-mp4"),
            btnDownloadGif: document.getElementById("btn-download-gif"),
            btnDrive: document.getElementById("btn-drive"),
            
            loader: document.getElementById("processing-overlay"),
            loadingText: document.getElementById("loading-text")
        };
    }

    /**
     * Inicializa o editor.
     * Busca o ID do vídeo no storage, recupera o Blob do IndexedDB e configura o player.
     */
    async init() {
        // 1. Busca o ID do vídeo no storage local
        const data = await chrome.storage.local.get(["videoId"]);
        
        if (!data.videoId) {
            alert("Nenhum vídeo encontrado para edição.");
            return;
        }

        this.fileName = this._generateFileName();

        try {
            // 2. Recupera o vídeo do "HD" (IndexedDB)
            const storage = new VideoStorage();
            
            // Aqui recuperamos o BLOB real gravado (remontado dos chunks)
            this.videoBlob = await storage.getVideo(data.videoId);
            
            // 3. Cria URL temporária para o player
            this.videoUrl = URL.createObjectURL(this.videoBlob);
            
            // 4. Carrega no player
            await this._loadVideo(this.videoUrl);
            
            // 5. Inicia FFmpeg em background (pre-load para agilizar cortes futuros)
            this.transcoder.init().catch(console.error);
            
            // 6. Configura listeners de botões e sliders
            this._setupListeners();

        } catch (error) {
            console.error("Erro no init:", error);
            alert("Erro ao carregar vídeo do disco: " + error.message);
        }
    }

    /**
     * Carrega a URL do vídeo no elemento <video> e aguarda metadados.
     * Trata o bug de "duração infinita" comum em gravações WebM do Chrome.
     * @param {string} url - Blob URL do vídeo.
     */
    async _loadVideo(url) {
        this.ui.video.src = url;

        return new Promise((resolve) => {
            this.ui.video.onloadedmetadata = async () => {
                // Correção do bug de duração infinita do Chrome (comum em webm)
                if (this.ui.video.duration === Infinity) {
                    this.duration = await this._fixVideoDuration(this.ui.video);
                } else {
                    this.duration = this.ui.video.duration;
                }
                
                this._resetSlider();
                this._enableButtons();
                resolve();
            };
            
            this.ui.video.onerror = () => {
                console.error("Erro no player de vídeo:", this.ui.video.error);
                resolve(); // Resolve para não travar a aplicação
            };
        });
    }

    /**
     * Hack para forçar o navegador a calcular a duração real de um arquivo WebM.
     * Pula para um tempo absurdo (1e101), o navegador ajusta para o fim real, e lemos o tempo.
     * @param {HTMLVideoElement} videoElement 
     * @returns {Promise<number>} A duração calculada.
     */
    _fixVideoDuration(videoElement) {
        return new Promise((resolve) => {
            videoElement.currentTime = 1e101;
            videoElement.ontimeupdate = () => {
                videoElement.ontimeupdate = null;
                const d = videoElement.duration;
                videoElement.currentTime = 0;
                resolve(d);
            };
        });
    }

    /**
     * Configura os event listeners da interface.
     */
    _setupListeners() {
        this.ui.rangeMin.addEventListener("input", () => this._updateSlider("min"));
        this.ui.rangeMax.addEventListener("input", () => this._updateSlider("max"));

        this.ui.btnCut.addEventListener("click", () => this._handleCut());
        this.ui.btnDownload.addEventListener("click", () => this._handleDownload(this.currentExtension));
        this.ui.btnDownloadMp4.addEventListener("click", () => this._handleConvertAndDownloadMP4());
        this.ui.btnDownloadGif.addEventListener("click", () => this._handleConvertAndDownloadGif());
        this.ui.btnDrive.addEventListener("click", () => this._handleDriveUpload());
    }

    /**
     * Reinicia o slider para cobrir 100% do vídeo (0 a 100).
     */
    _resetSlider() {
        this.ui.rangeMin.value = 0;
        this.ui.rangeMax.value = 100;
        this._renderSliderFill();
        this._updateTimeInputs();
    }

    /**
     * Atualiza a lógica do slider duplo (impedindo cruzamento dos handles).
     * @param {string} source - 'min' ou 'max' indicando qual handle foi movido.
     */
    _updateSlider(source) {
        const minVal = parseFloat(this.ui.rangeMin.value);
        const maxVal = parseFloat(this.ui.rangeMax.value);
        const gap = 5; // Distância mínima em %

        if (source === "min") {
            if (maxVal - minVal < gap) this.ui.rangeMin.value = maxVal - gap;
        } else {
            if (maxVal - minVal < gap) this.ui.rangeMax.value = minVal + gap;
        }
        this._renderSliderFill();
        this._updateTimeInputs();
    }

    /**
     * Renderiza a barra colorida entre os dois handles do slider.
     */
    _renderSliderFill() {
        const minVal = this.ui.rangeMin.value;
        const maxVal = this.ui.rangeMax.value;
        this.ui.rangeFill.style.left = minVal + "%";
        this.ui.rangeFill.style.width = (maxVal - minVal) + "%";
    }

    /**
     * Converte a posição do slider (%) para tempo real (HH:MM:SS) e atualiza os inputs.
     */
    _updateTimeInputs() {
        const startPercent = parseFloat(this.ui.rangeMin.value);
        const endPercent = parseFloat(this.ui.rangeMax.value);
        const startTime = (startPercent / 100) * this.duration;
        const endTime = (endPercent / 100) * this.duration;
        this.ui.startTimeInput.value = this._formatTime(startTime);
        this.ui.endTimeInput.value = this._formatTime(endTime);
    }

    // ==========================================
    // AÇÕES PRINCIPAIS
    // ==========================================

    /**
     * Corta o vídeo usando FFmpeg e atualiza o player com o novo arquivo.
     * Mantém o formato WebM para performance.
     */
    async _handleCut() {
        if (this.isProcessing) return;
        this._setLoading(true, "Cortando vídeo (WebM)...");

        try {
            const startSec = this._timeToSeconds(this.ui.startTimeInput.value);
            const endSec = this._timeToSeconds(this.ui.endTimeInput.value);
            const duration = endSec - startSec;

            if (duration <= 0) throw new Error("Duração inválida.");

            // Processa mantendo WebM (mais rápido pois não reencoda tudo se usar stream copy, ou reencoda rápido em VP8)
            const newVideoUrl = await this.transcoder.processVideo(
                this.videoBlob, 
                this.fileName, 
                startSec, 
                duration, 
                "webm"
            );

            // Atualiza o vídeo atual (na memória RAM apenas para edição imediata)
            const resp = await fetch(newVideoUrl);
            this.videoBlob = await resp.blob();
            this.currentExtension = "webm"; 
            
            await this._loadVideo(newVideoUrl);

        } catch (error) {
            console.error(error);
            alert("Erro ao cortar: " + error.message);
        } finally {
            this._setLoading(false);
        }
    }

    /**
     * Baixa o arquivo atual (WebM ou MP4, dependendo do estado atual).
     * @param {string} extension 
     */
    _handleDownload(extension) {
        if (!this.videoBlob) return;
        this._triggerDownload(this.ui.video.src, extension);
    }

    /**
     * Converte o vídeo atual para GIF e baixa.
     */
    async _handleConvertAndDownloadGif() {
        if (this.isProcessing || !this.videoBlob) return;
        
        this._setLoading(true, "Gerando GIF (isso pode levar alguns segundos)...");

        try {
            const gifUrl = await this.transcoder.processVideo(
                this.videoBlob,
                this.fileName,
                0, 
                this.duration, 
                "gif"
            );

            this._triggerDownload(gifUrl, "gif");

        } catch (error) {
            console.error(error);
            alert("Erro ao criar GIF: " + error.message);
        } finally {
            this._setLoading(false);
        }
    }

    /**
     * Converte o vídeo atual para MP4 e baixa imediatamente.
     * Não altera o vídeo do player (o player continua mostrando o WebM).
     */
    async _handleConvertAndDownloadMP4() {
        if (this.isProcessing || !this.videoBlob) return;
        this._setLoading(true, "Convertendo para MP4...");

        try {
            const mp4Url = await this.transcoder.processVideo(
                this.videoBlob,
                this.fileName,
                0, // Início
                this.duration, // Fim (converte tudo)
                "mp4"
            );

            this._triggerDownload(mp4Url, "mp4");

        } catch (error) {
            console.error(error);
            alert("Erro ao converter MP4: " + error.message);
        } finally {
            this._setLoading(false);
        }
    }

    /**
     * Faz o upload para o Google Drive.
     * Solicita o token ao background e usa o DriveService localmente.
     */
    async _handleDriveUpload() {
        if (this.isProcessing || !this.videoBlob) return;
        
        this._setLoading(true, "Autenticando e Enviando...");
        this.ui.btnDrive.disabled = true;

        try {
            // 1. Pede o Token ao Background (Mensagem leve, só texto)
            const authResponse = await chrome.runtime.sendMessage({ action: "get_auth_token" });
            
            if (!authResponse || !authResponse.token) {
                throw new Error("Falha na autenticação com Google.");
            }

            // 2. Faz o Upload DIRETAMENTE DAQUI (evita passar blob gigante por mensagem)
            const result = await this.driveService.uploadVideoWithToken(
                authResponse.token,
                this.videoBlob,
                this.fileName + "." + this.currentExtension
            );

            this._setLoading(false);
            
            // Sucesso
            if (result && result.fileViewLink) {
                const originalText = this.ui.btnDrive.innerHTML;
                this.ui.btnDrive.innerHTML = `<i class="fa-solid fa-check"></i> Link Copiado!`;
                
                // Copia link para área de transferência
                navigator.clipboard.writeText(result.fileViewLink);
                
                // Abre o link do drive em nova aba
                window.open(result.fileViewLink, '_blank');
                
                setTimeout(() => {
                    this.ui.btnDrive.innerHTML = originalText;
                    this.ui.btnDrive.disabled = false;
                }, 3000);
            }

        } catch (error) {
            this._setLoading(false);
            console.error("Erro no upload:", error);
            alert("Erro ao enviar: " + (error.message || error));
            this.ui.btnDrive.disabled = false;
        }
    }

    /**
     * Cria um link temporário e clica nele para forçar download.
     */
    _triggerDownload(url, ext) {
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = `${this.fileName}.${ext}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => document.body.removeChild(a), 100);
    }

    /**
     * Alterna o estado de carregamento da UI (Overlay + Spinner).
     */
    _setLoading(active, text) {
        this.isProcessing = active;
        this.ui.loadingText.innerText = text;
        this.ui.loader.style.display = active ? "flex" : "none";
        this.ui.btnCut.disabled = active;
        this.ui.btnDownload.disabled = active;
        this.ui.btnDownloadMp4.disabled = active;
        this.ui.btnDownloadGif.disabled = active;
    }

    _enableButtons() {
        this.ui.btnCut.disabled = false;
        this.ui.btnDownload.disabled = false;
        this.ui.btnDownloadMp4.disabled = false;
        this.ui.btnDownloadGif.disabled = false;
        this.ui.btnDrive.disabled = false;
    }

    _generateFileName() {
        const now = new Date();
        const date = now.toLocaleDateString("en-CA");
        const time = now.toTimeString().slice(0, 5).replace(":", "-");
        return `solutto-recorder-${date}_${time}`;
    }

    _formatTime(s) {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        return [h, m, sec].map(v => String(v).padStart(2, '0')).join(":");
    }

    _timeToSeconds(str) {
        const [h, m, s] = str.split(":").map(Number);
        return (h * 3600) + (m * 60) + s;
    }
}

// Inicializa a aplicação quando o DOM estiver pronto
document.addEventListener("DOMContentLoaded", () => {
    const editor = new EditorManager();
    editor.init();
});