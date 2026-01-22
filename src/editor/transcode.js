/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 */
export class TranscodeService {

    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;

        const baseUrl = "/src/lib/ffmpeg/";
        this.coreUrl = chrome.runtime.getURL(`${baseUrl}ffmpeg-core.js`);
        this.wasmUrl = chrome.runtime.getURL(`${baseUrl}ffmpeg-core.wasm`);
        this.workerUrl = chrome.runtime.getURL(`${baseUrl}ffmpeg-core.worker.js`);
    }

    _calcMemory() {
        try {
            const dm = navigator.deviceMemory || 4;
            const maxMb = Math.min(dm * 1024 * 0.8, 2048);
            const pages = Math.floor((maxMb * 1024 * 1024) / 65536);
            return { pages };
        } catch {
            return { pages: 1024 };
        }
    }

    async load() {
        return this.init();
    }

    async init() {
        if (this.isLoaded && this.ffmpeg) return;

        const scope = window.FFmpegWASM || window.FFmpeg;
        if (!scope) throw new Error("Biblioteca FFmpeg não encontrada no escopo global.");

        const { FFmpeg } = scope;

        this.ffmpeg = new FFmpeg({
            coreURL: this.coreUrl,
            wasmURL: this.wasmUrl,
            workerURL: this.workerUrl
        });

        this.ffmpeg.on("log", (evt) => {
            const msg = (typeof evt === "string") ? evt : (evt && evt.message);
            if (msg && typeof msg === "string") {
                if (!msg.startsWith('Aborted')) {
                    console.log("[FFmpeg]:", msg);
                }
            }
        });

        try {
            await this.ffmpeg.load({
                coreURL: this.coreUrl,
                wasmURL: this.wasmUrl,
                workerURL: this.workerUrl
            });
            this.isLoaded = true;
        } catch (error) {
            console.error("Solutto Transcoder: Erro crítico na inicialização.", error);
            this.isLoaded = false;
            throw error;
        }
    }

    _getFetchFile() {
        if (window.FFmpegUtil && window.FFmpegUtil.fetchFile) return window.FFmpegUtil.fetchFile;
        throw new Error("FFmpegUtil.fetchFile indisponível.");
    }

    async cancelJob() {
        if (this.ffmpeg) {
            try { await this.ffmpeg.terminate(); } catch (e) { console.warn("Erro ao terminar FFmpeg:", e); }
            this.ffmpeg = null;
            this.isLoaded = false;
        }
    }

    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm', options = {}, onProgress = null) {
        if (!this.isLoaded) await this.init();

        const { fetchFile } = window.FFmpegUtil;
        const safeId = Date.now() + "_" + Math.floor(Math.random() * 1000);

        const type = fileBlob.type || '';
        let ext = 'webm';
        if (type.includes('mp4')) ext = 'mp4';
        else if (type.includes('jpeg') || type.includes('jpg')) ext = 'jpg';
        else if (type.includes('png')) ext = 'png';
        else if (type.includes('gif')) ext = 'gif';

        const inputName = `proc_in_${safeId}.${ext}`;
        const outputName = `proc_out_${safeId}.${format}`;

        const logHandler = ({ message }) => {
            if (!onProgress) return;
            const timeMatch = message.match(/time=\s*(\d{2}:\d{2}:\d{2}\.\d{2})/);
            if (timeMatch) {
                const timeStr = timeMatch[1];
                const [h, m, s] = timeStr.split(':');
                const secondsProcessed = (parseInt(h) * 3600) + (parseInt(m) * 60) + parseFloat(s);
                let targetDuration = duration;
                if (format === 'gif' && duration > 10) targetDuration = 5;
                const pct = targetDuration > 0 ? Math.min(1, secondsProcessed / targetDuration) : 0;
                onProgress({ secondsProcessed, percent: pct });
            }
        };

        this.ffmpeg.on("log", logHandler);

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];
            const isImage = type.startsWith('image');
            const hasVisualFilters = (options.opacity !== undefined && options.opacity < 1);
            const canStreamCopy = !isImage && !hasVisualFilters && (ext === format);

            if (canStreamCopy) {
                command.push("-ss", startTime.toString());
                command.push("-i", inputName);
                command.push("-t", duration.toString());
                command.push("-c", "copy", "-avoid_negative_ts", "make_zero");
                if (format === 'mp4') command.push("-movflags", "+faststart");
            } else {
                if (isImage && format !== 'gif') command.push("-loop", "1");
                if (!isImage) command.push("-r", "30");

                command.push("-i", inputName);
                if (!isImage) command.push("-ss", startTime.toString());
                command.push("-t", duration.toString());

                let videoFilters = [];
                if (hasVisualFilters && format !== 'gif') {
                    videoFilters.push("format=yuva420p");
                    const alphaVal = Math.floor(options.opacity * 255);
                    videoFilters.push(`lutyuv=a=${alphaVal}`);
                }

                if (format === 'gif') {
                    const ptsFilter = (duration > 10) ? `,setpts=PTS/${(duration / 5).toFixed(2)}` : '';
                    videoFilters.push(`fps=10,scale=480:-1:flags=lanczos${ptsFilter}`);
                    command.push("-vf", videoFilters.join(","));
                    command.push("-f", "gif");
                }
                else if (format === 'mp4') {
                    videoFilters.push("scale='min(1920,iw)':-2:flags=lanczos");
                    if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                    command.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k");
                }
                else {
                    videoFilters.push("setsar=1");
                    if (videoFilters.length > 0) command.push("-vf", videoFilters.join(","));
                    command.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-crf", "15", "-b:v", "0", "-c:a", "libvorbis", "-b:a", "128k");
                }
            }

            command.push(outputName);
            await this.ffmpeg.exec(command);
            const data = await this.ffmpeg.readFile(outputName);
            let mimeType = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");
            return URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));
        } catch (error) {
            console.error("Transcode Error:", error);
            throw error;
        } finally {
            this.ffmpeg.off("log", logHandler);
            try { await this.ffmpeg.deleteFile(inputName); } catch (e) { }
            try { await this.ffmpeg.deleteFile(outputName); } catch (e) { }
        }
    }

    /**
     * Mescla múltiplos segmentos de vídeo.
     * Utiliza Re-encode Otimizado (Ultrafast) para corrigir timestamps quebrados
     * do MediaRecorder (Duration: N/A) e garantir estabilidade.
     */
    async mergeSegments(segments, outputName = "merged") {
        if (!this.isLoaded) await this.init();
        if (!segments || segments.length === 0) throw new Error("Sem segmentos para mesclar.");

        console.log("[SmartMerge] Iniciando Ultrafast Re-encode...");
        return await this._mergeUltrafast(segments, outputName);
    }

    async _mergeUltrafast(segments, baseName) {
        const fetchFile = this._getFetchFile();
        const timestamp = Date.now();
        const inputFiles = [];
        const inputArgs = [];
        const filterParts = [];
        const outName = `merged_${baseName}_${timestamp}.webm`;

        try {
            for (let i = 0; i < segments.length; i++) {
                const name = `seg_${i}_${timestamp}.webm`;
                await this.ffmpeg.writeFile(name, await fetchFile(segments[i]));
                inputFiles.push(name);
                inputArgs.push("-i", name);

                const normFilter = `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
                filterParts.push(normFilter);
            }

            let concatInputs = "";
            for (let i = 0; i < segments.length; i++) concatInputs += `[v${i}][${i}:a]`;

            const n = segments.length;
            const fullFilterGraph = filterParts.join("") + `${concatInputs}concat=n=${n}:v=1:a=1[v][a]`;

            await this.ffmpeg.exec([
                ...inputArgs,
                "-filter_complex", fullFilterGraph,
                "-map", "[v]", "-map", "[a]",

                "-c:v", "libvpx",         
                "-deadline", "realtime",  
                "-cpu-used", "8",         
                "-crf", "26",             
                "-b:v", "1500k",         
                "-c:a", "libvorbis",      

                outName
            ]);

            const data = await this.ffmpeg.readFile(outName);
            if (data.byteLength === 0) throw new Error("Arquivo vazio gerado no Merge.");
            return URL.createObjectURL(new Blob([data.buffer], { type: "video/webm" }));

        } catch (e) {
            console.error("Erro no mergeUltrafast:", e);
            throw e;
        } finally {
            try { await this.ffmpeg.deleteFile(outName); } catch (e) { }
            for (const f of inputFiles) { try { await this.ffmpeg.deleteFile(f); } catch (e) { } }
        }
    }
}