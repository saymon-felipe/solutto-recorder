/**
 * AudioMixer - Serviço de Mixagem de Áudio.
 * Utiliza a Web Audio API para combinar múltiplos streams de áudio (ex: som do sistema + microfone)
 * em uma única trilha de áudio para a gravação final.
 * * @note Este serviço foca apenas na mixagem para o ARQUIVO. O retorno de áudio para o usuário
 * (monitoramento) é tratado separadamente via WebRTC na aba de playback.
 */
(function () {
    class AudioMixer {
        constructor() {
            this.audioContext = null;
            this.sources = [];
            this.destination = null;
        }

        /**
         * Mistura duas streams de áudio em uma única saída.
         * Se não houver stream secundária, retorna a original.
         * * @param {MediaStream} baseStream - Stream principal (geralmente Tela ou Aba, contendo vídeo e áudio do sistema).
         * @param {MediaStream} secondaryStream - Stream secundária (geralmente Microfone).
         * @returns {MediaStream} Nova stream contendo as faixas de vídeo originais e a faixa de áudio mixada.
         */
        mix(baseStream, secondaryStream) {
            // Otimização: Se não tem microfone, não gasta processamento de áudio
            if (!secondaryStream) {
                return baseStream;
            }

            const baseAudioTracks = baseStream.getAudioTracks();
            
            // Cenário: Gravando tela (vídeo) sem som do sistema, apenas com microfone
            if (baseAudioTracks.length === 0) {
                return new MediaStream([
                    ...baseStream.getVideoTracks(),
                    ...secondaryStream.getAudioTracks()
                ]);
            }

            // Inicia Contexto de Mixagem (AudioContext)
            // Suporte para prefixo webkit para compatibilidade
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.destination = this.audioContext.createMediaStreamDestination();

            // 1. Conecta o áudio da ABA/TELA ao destino (Arquivo)
            if (baseAudioTracks.length > 0) {
                const source1 = this.audioContext.createMediaStreamSource(baseStream);
                source1.connect(this.destination);
                this.sources.push(source1);
            }

            // 2. Conecta o MICROFONE ao destino (Arquivo)
            const secAudioTracks = secondaryStream.getAudioTracks();
            if (secAudioTracks.length > 0) {
                const source2 = this.audioContext.createMediaStreamSource(secondaryStream);
                source2.connect(this.destination);
                this.sources.push(source2);
            }

            // Monta a stream final: Vídeo Original + Áudio Mixado
            const mixedStream = new MediaStream([
                ...baseStream.getVideoTracks(),
                ...this.destination.stream.getAudioTracks()
            ]);

            return mixedStream;
        }

        /**
         * Encerra o contexto de áudio e libera recursos.
         * Deve ser chamado ao final da gravação para evitar vazamento de memória ou processamento zumbi.
         */
        cleanup() {
            if (this.audioContext) {
                this.audioContext.close().catch(e => console.warn("Erro ao fechar AudioContext:", e));
                this.audioContext = null;
            }
            this.sources = [];
            this.destination = null;
        }
    }

    // Exporta para o escopo global (padrão IIFE usado no Content Script)
    window.SoluttoAudioMixer = AudioMixer;
})();