import { DriveService } from '../services/DriveService.js';
import { VideoStorage } from '../services/VideoStorage.js';
import { TranscodeService } from './transcode.js';
import { StudioManager } from './studio/studio.js';

class EditorManager {
    constructor() {
        this.videoBlob = null;
        this.videoUrl = null;
        this.fileName = "";
        this.duration = 0;
        this.isProcessing = false;
        this.currentExtension = "webm"; 

        // Instancia Studio
        this.studio = new StudioManager(this);

        this.driveService = new DriveService();
        this.transcoder = new TranscodeService();

        // Mapeia UI
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
            loadingText: document.getElementById("loading-text"),
            btnOpenStudio: document.getElementById("btn-open-studio")
        };
    }

    async init() {
        // Inicia UI do Studio
        this.studio.init();

        const params = new URLSearchParams(window.location.search);
        const mode = params.get('mode');

        if (mode === 'studio') {
            this.studio.toggleMode();
            return;
        }

        const data = await chrome.storage.local.get(["videoId"]);
        if (!data.videoId) return alert("Nenhum vídeo encontrado.");

        this.fileName = this._generateFileName();
        this._setLoading(true, "Carregando vídeo...");

        try {
            await this.transcoder.init();
            const storage = new VideoStorage();
            
            // Lógica de Crash Recovery (Segmentos)
            const segments = await storage.getVideoSegments(data.videoId);
            console.log(`Recuperado ${segments.length} segmentos.`);

            if (segments.length > 1) {
                this._setLoading(true, "Unindo gravação...");
                this.videoUrl = await this.transcoder.mergeSegments(segments, "merged_video");
                const resp = await fetch(this.videoUrl);
                this.videoBlob = await resp.blob();
            } else {
                this.videoBlob = segments[0];
                this.videoUrl = URL.createObjectURL(this.videoBlob);
            }
            
            await this._loadVideo(this.videoUrl);
            this._setupListeners();

        } catch (error) {
            console.error("Erro init:", error);
            alert("Erro: " + error.message);
        } finally {
            this._setLoading(false);
        }
    }

    async _loadVideo(url) {
        this.ui.video.src = url;
        return new Promise((resolve) => {
            this.ui.video.onloadedmetadata = async () => {
                if (this.ui.video.duration === Infinity) {
                    this.duration = await this._fixVideoDuration(this.ui.video);
                } else {
                    this.duration = this.ui.video.duration;
                }
                this._resetSlider();
                this._enableButtons();
                resolve();
            };
            this.ui.video.onerror = (e) => { console.error("Erro Player:", this.ui.video.error); resolve(); };
        });
    }

    _fixVideoDuration(videoElement) {
        return new Promise((resolve) => {
            videoElement.currentTime = 1e101;
            videoElement.ontimeupdate = () => {
                videoElement.ontimeupdate = null;
                resolve(videoElement.duration);
            };
        });
    }

    _setupListeners() {
        // Listeners seguros (verificam se o elemento existe)
        if(this.ui.rangeMin) this.ui.rangeMin.addEventListener("input", () => this._updateSlider("min"));
        if(this.ui.rangeMax) this.ui.rangeMax.addEventListener("input", () => this._updateSlider("max"));
        
        if(this.ui.btnCut) this.ui.btnCut.addEventListener("click", () => this._handleCut());
        
        // Botões de Download
        if(this.ui.btnDownload) this.ui.btnDownload.addEventListener("click", () => this._handleDownload("webm"));
        if(this.ui.btnDownloadMp4) this.ui.btnDownloadMp4.addEventListener("click", () => this._handleConvertAndDownloadMP4());
        if(this.ui.btnDownloadGif) this.ui.btnDownloadGif.addEventListener("click", () => this._handleConvertAndDownloadGif());
        
        if(this.ui.btnDrive) this.ui.btnDrive.addEventListener("click", () => this._handleDriveUpload());
        
        // Botão Studio
        if(this.ui.btnOpenStudio) this.ui.btnOpenStudio.addEventListener("click", () => this.studio.toggleMode());
    }
    
    _resetSlider() {
        this.ui.rangeMin.value = 0;
        this.ui.rangeMax.value = 100;
        this._renderSliderFill();
        this._updateTimeInputs();
    }

    _updateSlider(source) {
        const minVal = parseFloat(this.ui.rangeMin.value);
        const maxVal = parseFloat(this.ui.rangeMax.value);
        const gap = 5;
        if (source === "min") {
            if (maxVal - minVal < gap) this.ui.rangeMin.value = maxVal - gap;
        } else {
            if (maxVal - minVal < gap) this.ui.rangeMax.value = minVal + gap;
        }
        this._renderSliderFill();
        this._updateTimeInputs();
    }

    _renderSliderFill() {
        const minVal = this.ui.rangeMin.value;
        const maxVal = this.ui.rangeMax.value;
        this.ui.rangeFill.style.left = minVal + "%";
        this.ui.rangeFill.style.width = (maxVal - minVal) + "%";
    }

    _updateTimeInputs() {
        if (!this.duration) return;
        const startPercent = parseFloat(this.ui.rangeMin.value);
        const endPercent = parseFloat(this.ui.rangeMax.value);
        this.ui.startTimeInput.value = this._formatTime((startPercent / 100) * this.duration);
        this.ui.endTimeInput.value = this._formatTime((endPercent / 100) * this.duration);
    }

    async _handleCut() {
        if (this.isProcessing) return;
        this._setLoading(true, "Cortando vídeo...");
        try {
            const startSec = this._timeToSeconds(this.ui.startTimeInput.value);
            const endSec = this._timeToSeconds(this.ui.endTimeInput.value);
            const duration = endSec - startSec;
            const newVideoUrl = await this.transcoder.processVideo(this.videoBlob, this.fileName, startSec, duration, "webm");
            const resp = await fetch(newVideoUrl);
            this.videoBlob = await resp.blob();
            await this._loadVideo(newVideoUrl);
        } catch (e) { alert(e.message); } finally { this._setLoading(false); }
    }

    _handleDownload(ext) { if(this.videoBlob) this._triggerDownload(this.ui.video.src, ext); }

    async _handleConvertAndDownloadMP4() {
        if (this.isProcessing) return;
        this._setLoading(true, "Convertendo MP4...");
        try {
            const url = await this.transcoder.processVideo(this.videoBlob, this.fileName, 0, this.duration, "mp4");
            this._triggerDownload(url, "mp4");
        } catch(e){ alert(e.message); } finally { this._setLoading(false); }
    }

    async _handleConvertAndDownloadGif() {
        if (this.isProcessing) return;
        this._setLoading(true, "Gerando GIF...");
        try {
            const url = await this.transcoder.processVideo(this.videoBlob, this.fileName, 0, this.duration, "gif");
            this._triggerDownload(url, "gif");
        } catch(e){ alert(e.message); } finally { this._setLoading(false); }
    }

    async _handleDriveUpload() {
         if (this.isProcessing) return;
         this._setLoading(true, "Enviando...");
         try {
             const auth = await chrome.runtime.sendMessage({ action: "get_auth_token" });
             if(!auth || !auth.token) throw new Error("Auth falhou");
             const res = await this.driveService.uploadVideoWithToken(auth.token, this.videoBlob, this.fileName + ".webm");
             if(res.fileViewLink) window.open(res.fileViewLink);
         } catch(e) { alert(e.message); } finally { this._setLoading(false); }
    }

    _triggerDownload(url, ext) {
        const a = document.createElement("a");
        a.href = url; a.download = `${this.fileName}.${ext}`;
        document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 100);
    }

    _setLoading(active, text) {
        this.isProcessing = active;
        if (this.ui.loadingText) this.ui.loadingText.innerText = text || "Carregando...";
        if (this.ui.loader) this.ui.loader.style.display = active ? "flex" : "none";
        
        [this.ui.btnCut, this.ui.btnDownload, this.ui.btnDownloadMp4, this.ui.btnDownloadGif, this.ui.btnDrive].forEach(b => { if(b) b.disabled = active; });
    }

    _enableButtons() {
        [this.ui.btnCut, this.ui.btnDownload, this.ui.btnDownloadMp4, this.ui.btnDownloadGif, this.ui.btnDrive].forEach(b => { if(b) b.disabled = false; });
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

document.addEventListener("DOMContentLoaded", () => { const e = new EditorManager(); e.init(); });