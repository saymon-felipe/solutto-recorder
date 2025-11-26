/**
 * TranscodeService
 * Wrapper para a biblioteca FFmpeg.wasm.
 */
export class TranscodeService {
    constructor() {
        this.ffmpeg = null;
        this.isLoaded = false;
        
        // Caminhos para o Core (Worker e Wasm)
        this.coreUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.js");
        this.wasmUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.wasm");
        this.workerUrl = chrome.runtime.getURL("/src/lib/ffmpeg/ffmpeg-core.worker.js");
    }

    /**
     * Injeta scripts UMD na página dinamicamente.
     * Necessário porque imports ES6 falham em alguns contextos de extensão.
     */
    _loadScript(url) {
        return new Promise((resolve, reject) => {
            // Verifica se já está carregado para evitar duplicidade
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

        console.log("Transcoder: Inicializando bibliotecas...");

        try {
            // 1. Carrega os arquivos JS da biblioteca (UMD)
            await this._loadScript(chrome.runtime.getURL("src/lib/ffmpeg/umd/ffmpeg.js"));
            await this._loadScript(chrome.runtime.getURL("src/lib/ffmpeg/util.js"));

            // 2. Localiza a Classe FFmpeg no escopo global
            const scope = window.FFmpegWASM || window.FFmpeg;
            if (!scope) throw new Error("Biblioteca FFmpeg não encontrada no window.");

            let FFmpegConstructor;

            if (typeof scope === 'function') {
                FFmpegConstructor = scope;
            } else if (scope.FFmpeg) {
                FFmpegConstructor = scope.FFmpeg;
            } else {
                throw new Error("Construtor FFmpeg não identificado.");
            }

            // 3. Instancia
            this.ffmpeg = new FFmpegConstructor();

            this.ffmpeg.on("log", ({ message }) => console.log("[FFmpeg Core]:", message));

            // 4. Carrega o WebAssembly (Core)
            await this.ffmpeg.load({
                coreURL: this.coreUrl,
                wasmURL: this.wasmUrl,
                workerURL: this.workerUrl
            });

            this.isLoaded = true;
            console.log("Transcoder: FFmpeg pronto!");

        } catch (error) {
            console.error("Solutto Transcoder: Falha no init.", error);
            throw error;
        }
    }

    /**
     * Helper para acessar fetchFile globalmente com segurança.
     */
    _getFetchFile() {
        if (window.FFmpegUtil && window.FFmpegUtil.fetchFile) {
            return window.FFmpegUtil.fetchFile;
        }
        throw new Error("FFmpegUtil.fetchFile não disponível. Verifique o carregamento de util.js");
    }

    /**
     * Junta múltiplos segmentos de vídeo (Blobs) em um único arquivo WebM limpo.
     */
    async mergeSegments(blobs, outputName) {
        if (!this.isLoaded) await this.init();

        const fetchFile = this._getFetchFile();
        const fileList = [];
        
        console.log(`Transcoder: Unindo ${blobs.length} segmentos...`);

        // 1. Escreve segmentos no FS virtual
        for (let i = 0; i < blobs.length; i++) {
            const name = `part${i}.webm`;
            await this.ffmpeg.writeFile(name, await fetchFile(blobs[i]));
            fileList.push(`file '${name}'`);
        }

        // 2. Cria lista para concat
        await this.ffmpeg.writeFile('list.txt', fileList.join('\n'));

        // 3. Executa concat (copy streams para velocidade máxima)
        await this.ffmpeg.exec([
            '-f', 'concat', 
            '-safe', '0', 
            '-i', 'list.txt', 
            '-c', 'copy', 
            outputName + '.webm'
        ]);

        // 4. Recupera resultado
        const data = await this.ffmpeg.readFile(outputName + '.webm');
        
        // Limpeza
        for (let i = 0; i < blobs.length; i++) await this.ffmpeg.deleteFile(`part${i}.webm`);
        await this.ffmpeg.deleteFile('list.txt');
        await this.ffmpeg.deleteFile(outputName + '.webm');

        return URL.createObjectURL(new Blob([data.buffer], { type: 'video/webm' }));
    }

    /**
     * Processa vídeo único (Corte/Conversão).
     */
    async processVideo(fileBlob, fileName, startTime, duration, format = 'webm') {
        if (!this.isLoaded) await this.init();

        const fetchFile = this._getFetchFile();
        const inputName = `input_${fileName}`;
        const outputName = `output_${fileName}.${format}`;

        try {
            await this.ffmpeg.writeFile(inputName, await fetchFile(fileBlob));

            let command = [];
            command.push("-i", inputName);
            command.push("-ss", startTime.toString());
            command.push("-t", duration.toString());

            if (format === 'gif') {
                command.push("-vf", "fps=10,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "-f", "gif");
            } else if (format === 'mp4') {
                command.push("-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart");
            } else {
                command.push("-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libvorbis");
            }

            command.push(outputName);
            console.log("Transcoder Exec:", command.join(" "));
            
            await this.ffmpeg.exec(command);

            const data = await this.ffmpeg.readFile(outputName);
            
            let mimeType = format === 'mp4' ? "video/mp4" : (format === 'gif' ? "image/gif" : "video/webm");
            return URL.createObjectURL(new Blob([data.buffer], { type: mimeType }));

        } catch (error) {
            console.error("Erro FFmpeg processVideo:", error);
            throw error;
        } finally {
            try {
                await this.ffmpeg.deleteFile(inputName);
                await this.ffmpeg.deleteFile(outputName);
            } catch (e) {}
        }
    }
}