import { pipeline, env } from '../transformers/transformers.js';

env.allowLocalModels = false; 
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1; 

env.backends.onnx.wasm.wasmPaths = {
    'ort-wasm-simd-threaded.wasm': '../transformers/ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd.wasm': '../transformers/ort-wasm-simd.wasm',
    'ort-wasm-threaded.wasm': '../transformers/ort-wasm-threaded.wasm',
    'ort-wasm.wasm': '../transformers/ort-wasm.wasm'
};

console.log("[Worker] Inicializado. Single-Thread (Small Model).");

class PipelineFactory {
    static task = 'automatic-speech-recognition';
    static model = 'Xenova/whisper-small'; 
    static instance = null;

    static async getInstance(progressCallback = null) {
        if (this.instance === null) {
            console.log(`[Worker] Carregando modelo: ${this.model}`);
            this.instance = await pipeline(this.task, this.model, {
                quantized: true,
                progress_callback: progressCallback
            });
            console.log("[Worker] Pipeline pronto!");
        }
        return this.instance;
    }
}

function refineToWordLevel(chunks) {
    const detailedWords = [];
    chunks.forEach(chunk => {
        const text = chunk.text || "";
        const words = text.trim().split(/\s+/);
        if (words.length === 0) return;

        const start = chunk.timestamp[0];
        const end = chunk.timestamp[1];
        const duration = end - start;
        const timePerChar = duration / text.length;

        let currentOffset = 0;
        words.forEach(word => {
            const wordDuration = word.length * timePerChar;
            const wordStart = start + currentOffset;
            const wordEnd = wordStart + wordDuration;

            detailedWords.push({
                text: word,
                start: wordStart,
                end: wordEnd
            });
            currentOffset += wordDuration + timePerChar; 
        });
    });
    return detailedWords;
}

self.addEventListener('message', async (event) => {
    const { type, audio, language, offsetCorrection } = event.data;

    if (type === 'transcribe') {
        try {
            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    if (Math.round(data.progress) % 10 === 0) {
                        self.postMessage({ status: 'loading', data });
                    }
                }
            };

            const transcriber = await PipelineFactory.getInstance(progressCallback);
            
            const output = await transcriber(audio, {
                language: language || 'portuguese',
                task: 'transcribe',
                chunk_length_s: 30,
                stride_length_s: 5,
                return_timestamps: true,
                temperature: 0, 
            });

            // Garante estrutura Word-by-Word
            let wordLevelData = [];
            if (Array.isArray(output.chunks)) {
                wordLevelData = refineToWordLevel(output.chunks);
            } else {
                wordLevelData = refineToWordLevel([{ 
                    text: output.text, 
                    timestamp: [0, audio.length / 16000] 
                }]);
            }

            if (offsetCorrection && typeof offsetCorrection === 'number') {
                wordLevelData.forEach(w => {
                    w.start += offsetCorrection;
                    w.end += offsetCorrection;
                });
            }

            self.postMessage({ 
                status: 'complete', 
                output: {
                    text: output.text,
                    chunks: wordLevelData
                }
            });

        } catch (error) {
            console.error("[Worker] Erro:", error);
            self.postMessage({ status: 'error', error: error.message });
        }
    }
});