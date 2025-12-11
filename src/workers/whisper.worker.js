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
            console.log(`[Worker] Carregando modelo pesado: ${this.model}`);
            
            this.instance = await pipeline(this.task, this.model, {
                quantized: true, // Mantém ~250MB. Se fosse false, seria >1GB.
                progress_callback: progressCallback
            });
            
            console.log("[Worker] Pipeline pronto!");
        }
        return this.instance;
    }
}

self.addEventListener('message', async (event) => {
    const { type, audio, language } = event.data;

    if (type === 'transcribe') {
        try {
            const progressCallback = (data) => {
                if (data.status === 'progress') {
                    if (Math.round(data.progress) % 5 === 0) {
                        console.log(`[Worker] Download ${data.file}: ${Math.round(data.progress)}%`);
                    }
                }
                self.postMessage({ status: 'loading', data });
            };

            const transcriber = await PipelineFactory.getInstance(progressCallback);

            console.log(`[Worker] Processando áudio (${audio.length} samples)...`);
            
            const output = await transcriber(audio, {
                language: language || 'portuguese',
                task: 'transcribe',
                
                chunk_length_s: 30,
                stride_length_s: 5,
                return_timestamps: true,
                
                temperature: 0, 
                
                repetition_penalty: 1.2,
                no_repeat_ngram_size: 3
            });

            console.log("[Worker] Resultado:", output);
            self.postMessage({ status: 'complete', output });

        } catch (error) {
            console.error("[Worker] Erro:", error);
            self.postMessage({ status: 'error', error: error.message });
        }
    }
});