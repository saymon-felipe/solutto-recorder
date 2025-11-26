/**
 * TranscodeService
 */
export class TranscodeService {
    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;
        
        this.coreUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.js");
        this.wasmUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.wasm");
        this.workerUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.worker.js");
    }

    _loadScript(url) {
        return new Promise((resolve, reject) => {
            if (url.includes("ffmpeg.js") && (window.FFmpeg || window.FFmpegWASM)) return resolve();
            if (url.includes("util.js") && window.FFmpegUtil) return resolve();

            const script = document.createElement("script");
            script.src = url;
            script.type = "text/javascript";
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Falha ao carregar script: ${url}`));
            document.head.appendChild(script);
        });
    }

    async init() {
        if (this.isLoaded) return;
        console.log("Transcoder: Init...");

        try {
            await this._loadScript(chrome.runtime.getURL("src/lib/ffmpeg/umd/ffmpeg.js"));
            await this._loadScript(chrome.runtime.getURL("src/lib/ffmpeg/util.js"));

            const scope = window.FFmpegWASM || window.FFmpeg;
            if (!scope) throw new Error("Biblioteca FFmpeg não encontrada no window.");

            let FFmpegConstructor = typeof scope === 'function' ? scope : scope.FFmpeg;
            if (!FFmpegConstructor) throw new Error("Construtor FFmpeg não identificado.");

            this.ffmpeg = new FFmpegConstructor();
            this.ffmpeg.on("log", ({ message }) => console.log("[FFmpeg Core]:", message));

            await this.ffmpeg.load({
                coreURL: this.coreUrl, wasmURL: this.wasmUrl, workerURL: this.workerUrl
            });

            this.isLoaded = true;
        } catch (error) {
            console.error("Transcoder Init Error:", error);
            throw error;
        }
    }

    _getFetchFile() {
        if (window.FFmpegUtil && window.FFmpegUtil.fetchFile) return window.FFmpegUtil.fetchFile;
        throw new Error("FFmpegUtil.fetchFile indisponível.");
    }

    // --- Métodos ---

    async imageToVideo(imageBlob, durationSeconds = 5) {
        if (!this.isLoaded) await this.init();
        const fetchFile = this._getFetchFile();
        const inputName = "img_" + Date.now();
        const outputName = inputName + ".webm";

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(imageBlob));

            await this.ffmpeg.exec([
                "-loop", "1",
                "-i", inputName,
                "-c:v", "libvpx",
                "-t", durationSeconds.toString(),
                "-pix_fmt", "yuv420p",
                "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
                outputName
            ]);

            const data = await this.ffmpeg.readFile(outputName);
            await this.ffmpeg.deleteFile(inputName);
            await this.ffmpeg.deleteFile(outputName);

            return URL.createObjectURL(new Blob([data.buffer], { type: "video/webm" }));
        } catch (e) {
            console.error(e);
            throw new Error("Falha imageToVideo: " + (e.message || "Erro desconhecido"));
        }
    }

    async mergeSegments(blobs, outputName) {
        if (!this.isLoaded) await this.init();
        const fetchFile = this._getFetchFile();
        const fileList = [];
        
        try {
            for (let i = 0; i < blobs.length; i++) {
                const name = `part${i}.webm`;
                await this.ffmpeg.writeFile(name, await fetchFile(blobs[i]));
                fileList.push(`file '${name}'`);
            }

            await this.ffmpeg.writeFile('list.txt', fileList.join('\n'));

            await this.ffmpeg.exec([
                '-f', 'concat', '-safe', '0', '-i', 'list.txt', 
                '-c', 'copy', outputName + '.webm'
            ]);

            const data = await this.ffmpeg.readFile(outputName + '.webm');
            
            // Cleanup (opcional em produção para economizar RAM)
            for (let i = 0; i < blobs.length; i++) await this.ffmpeg.deleteFile(`part${i}.webm`);
            await this.ffmpeg.deleteFile('list.txt');
            await this.ffmpeg.deleteFile(outputName + '.webm');

            return URL.createObjectURL(new Blob([data.buffer], { type: 'video/webm' }));
        } catch (e) {
            throw new Error("Merge failed: " + (e.message || e));
        }
    }

    async processVideo(inputBlob, outputName, start, duration, format) {
        if (!this.isLoaded) await this.init();
        const fetchFile = this._getFetchFile();
        const inputName = 'input.webm';
        const outName = `${outputName}.${format}`;
        
        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(inputBlob));
            const args = ['-i', inputName];
            if (start > 0) args.push('-ss', start.toString());
            if (duration > 0) args.push('-t', duration.toString());

            if (format === 'mp4') args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac');
            else if (format === 'gif') args.push('-vf', 'fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-c:v', 'gif');
            else args.push('-c', 'copy');

            args.push(outName);
            await this.ffmpeg.exec(args);
            const data = await this.ffmpeg.readFile(outName);
            
            await this.ffmpeg.deleteFile(inputName);
            await this.ffmpeg.deleteFile(outName);

            let mime = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");
            return URL.createObjectURL(new Blob([data.buffer], { type: mime }));
        } catch (error) {
            throw new Error("ProcessVideo failed: " + (error.message || error));
        }
    }
}