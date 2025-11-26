/**
 * RecorderManager - Gerenciador de Gravação.
 * Controla o ciclo de vida do MediaRecorder, gerencia os chunks de vídeo,
 * controla a interface de timer/stop e realiza o upload do vídeo final para o Background (IndexedDB).
 */
(function () {
    const Utils = window.SoluttoUtils;
    const C = window.SoluttoConstants;
    const UI = window.SoluttoUIManager;

    class RecorderManager {
        constructor() {
            this.mediaRecorder = null;
            this.stream = null;
            this.chunks = []; // Armazena os blobs parciais do vídeo
            this.status = "idle"; // idle, recording, paused
            this.elapsedSeconds = 0;
            this.timerInterval = null;
            this.recordingType = null; // 'tab', 'screen', 'webcam'
            
            // Callback para avisar o Content Script que acabou a gravação
            // Usado para disparar a limpeza de streams e devolver o áudio da aba
            this.onStopCallback = null; 

            this.ui = UI.getInstance();
        }

        /**
         * Inicia o fluxo de gravação.
         * Configura o MediaRecorder, exibe contagem regressiva e inicia a UI flutuante.
         * * @param {MediaStream} stream - O stream combinado (vídeo + áudio) a ser gravado.
         * @param {number} timeoutSeconds - Tempo de contagem regressiva antes de começar.
         * @param {string} recordingType - Tipo da gravação ('screen', 'tab', 'webcam').
         * @param {Function} onStopCallback - Função a ser chamada quando a gravação finalizar (limpeza).
         */
        async start(stream, timeoutSeconds = 0, recordingType = "screen", onStopCallback = null) {
            if (this.status !== "idle") return;

            this.stream = stream;
            this.recordingType = recordingType;
            this.onStopCallback = onStopCallback; 
            this.chunks = [];

            // Tenta obter as melhores opções de codec (VP9 -> VP8 -> Default)
            const options = this._getRecorderOptions();
            try {
                this.mediaRecorder = new MediaRecorder(stream, options);
            } catch (e) {
                console.warn("Falha codec preferido:", e);
                // Fallback para configuração padrão do navegador
                this.mediaRecorder = new MediaRecorder(stream);
            }

            // Coleta os pedaços de vídeo conforme ficam disponíveis
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) this.chunks.push(e.data);
            };

            // Handler de parada (acionado por stop() ou fim do stream)
            this.mediaRecorder.onstop = () => this._handleStop();

            // Monitora se o usuário clicou em "Parar compartilhamento" na barra nativa do Chrome
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.onended = () => {
                    if (this.status !== "idle") this.stop();
                };
            }

            // Exibe contagem regressiva (bloqueante)
            if (timeoutSeconds > 0) {
                await this.ui.showCountdown(timeoutSeconds);
            }

            // Inicia gravação. Timeslice de 1000ms garante que temos dados a cada segundo (segurança contra crash)
            this.mediaRecorder.start(C.RECORDER.TIMESLICE_MS);
            this.status = "recording";
            
            this._startTimer();
            chrome.runtime.sendMessage({ action: C.ACTIONS.CHANGE_ICON, type: "recording" });
            
            // Exibe controles flutuantes e bind actions
            await this.ui.showControls((action) => this._handleUserAction(action));
        }

        /**
         * Pausa a gravação e o timer.
         */
        pause() {
            if (this.status === "recording" && this.mediaRecorder.state === "recording") {
                this.mediaRecorder.pause();
                this.status = "paused";
                this._stopTimer(false); // Para o relógio mas não zera
                this.ui.togglePauseState(true); // Atualiza ícone para Play
            }
        }

        /**
         * Retoma a gravação e o timer.
         */
        resume() {
            if (this.status === "paused" && this.mediaRecorder.state === "paused") {
                this.mediaRecorder.resume();
                this.status = "recording";
                this._startTimer();
                this.ui.togglePauseState(false); // Atualiza ícone para Pause
            }
        }

        /**
         * Finaliza a gravação com sucesso.
         * Dispara o evento 'onstop' onde o processamento real ocorre.
         */
        stop() {
            if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
                this.mediaRecorder.stop();
            }
        }

        /**
         * Cancela a gravação e descarta os dados.
         */
        cancel() {
            if (this.mediaRecorder) {
                this.mediaRecorder.onstop = null; // Remove listener para evitar salvamento
                this.mediaRecorder.stop();
            }
            this.chunks = [];
            this._cleanup();
        }

        /**
         * Processa ações vindas da UI flutuante.
         */
        _handleUserAction(action) {
            switch (action) {
                case C.ACTIONS.STOP_RECORDING: this.stop(); break;
                case "pause": this.pause(); break;
                case "resume": this.resume(); break;
                case C.ACTIONS.CANCEL_RECORDING: this.cancel(); break;
            }
        }

        /**
         * Handler executado quando a gravação termina com sucesso.
         * Gera o Blob final e envia para o Background em pedaços (Chunks) para salvar no IndexedDB.
         */
        async _handleStop() {
            console.log("RecorderManager: Processando vídeo...");
            
            const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || 'video/webm' });
            const videoId = "vid_" + Date.now();

            this._cleanup(); // Limpa UI imediatamente para feedback rápido

            try {
                // --- LÓGICA DE TRANSFERÊNCIA EM CHUNKS ---
                // Necessário pois 'sendMessage' tem limite de tamanho (~64MB)
                const chunkSize = 10 * 1024 * 1024; // 10MB
                const totalSize = blob.size;
                let offset = 0;
                let index = 0;

                console.log(`Iniciando transferência: ${totalSize} bytes em pedaços de ${chunkSize}`);

                while (offset < totalSize) {
                    const slice = blob.slice(offset, offset + chunkSize);
                    const buffer = await slice.arrayBuffer();
                    // Converte para array simples (serializável)
                    const dataArray = Array.from(new Uint8Array(buffer));

                    // Envia chunk e espera confirmação
                    await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            action: "save_chunk",
                            videoId: videoId,
                            index: index,
                            data: dataArray
                        }, (response) => {
                            if (chrome.runtime.lastError || response?.error) {
                                reject(chrome.runtime.lastError || response.error);
                            } else {
                                resolve();
                            }
                        });
                    });

                    offset += chunkSize;
                    index++;
                    console.log(`Chunk ${index} enviado.`);
                }

                // Finaliza o processo no background (que vai montar o vídeo e abrir o editor)
                chrome.runtime.sendMessage({
                    action: "finish_video",
                    videoId: videoId
                });

            } catch (error) {
                console.error("Erro crítico no upload para background:", error);
                alert("Erro ao salvar vídeo: " + error.message);
            }
        }

        /**
         * Limpa estado, remove UI e libera streams.
         */
        _cleanup() {
            this._stopTimer();
            this.ui.cleanup();
            
            // Para todas as tracks do gravador
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
            }

            // Se for gravação de aba, fecha a aba auxiliar
            if (this.recordingType === C.SOURCE_TYPE.TAB) {
                chrome.runtime.sendMessage({ action: C.ACTIONS.CLOSE_TABS });
            }

            // Executa callback de limpeza do Content Script (libera áudio original)
            if (this.onStopCallback) {
                this.onStopCallback();
                this.onStopCallback = null;
            }

            this.mediaRecorder = null;
            this.stream = null;
            this.status = "idle";
            this.recordingType = null;
            
            chrome.runtime.sendMessage({ action: C.ACTIONS.CHANGE_ICON, type: "default" });
        }

        _startTimer() {
            this._stopTimer(false);
            this.timerInterval = setInterval(() => {
                this.elapsedSeconds++;
                this.ui.updateTimer(this.elapsedSeconds);
            }, 1000);
        }

        _stopTimer(reset = true) {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            if (reset) this.elapsedSeconds = 0;
        }

        /**
         * Detecta o melhor codec suportado pelo navegador.
         */
        _getRecorderOptions() {
            for (const mimeType of C.RECORDER.MIME_TYPE_PREFERENCE) {
                if (MediaRecorder.isTypeSupported(mimeType)) {
                    return { mimeType: mimeType, videoBitsPerSecond: C.RECORDER.VIDEO_BITS_PER_SECOND };
                }
            }
            return {};
        }
    }

    window.SoluttoRecorderManager = RecorderManager;
})();