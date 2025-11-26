/**
 * SignalingService - WebRTC Sender.
 * Responsável por estabelecer uma conexão Peer-to-Peer (P2P) local entre o Content Script e a Aba de Playback.
 * Isso permite enviar o stream de áudio da aba atual para a aba de background, onde ele será reproduzido 
 * para manter a captura ativa ("Tab Mirroring").
 */
(function () {
    const C = window.SoluttoConstants;

    class SignalingService {
        constructor() {
            this.pc = null; // RTCPeerConnection (A conexão WebRTC)
            this.localStream = null;
        }

        /**
         * Inicializa a conexão WebRTC, adiciona as trilhas de mídia e configura os listeners de ICE.
         * * @param {MediaStream} stream - O stream de mídia (geralmente áudio da aba) a ser enviado.
         */
        startConnection(stream) {
            this.localStream = stream;
            
            // Configuração STUN do Google para permitir a descoberta de rota de rede (mesmo localmente)
            const configuration = {
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            };

            this.pc = new RTCPeerConnection(configuration);

            // Adiciona cada trilha (vídeo/áudio) do stream à conexão
            stream.getTracks().forEach(track => {
                this.pc.addTrack(track, stream);
            });

            // Listener de ICE Candidates:
            // Quando o navegador descobre um caminho de rede (candidato), enviamos para o par remoto (Playback)
            this.pc.onicecandidate = (event) => {
                if (event.candidate) {
                    chrome.runtime.sendMessage({ 
                        action: C.ACTIONS.WEBRTC_CANDIDATE, 
                        // Serialização JSON necessária para passar pela mensageria do Chrome
                        candidate: JSON.parse(JSON.stringify(event.candidate)) 
                    });
                }
            };
        }

        /**
         * Cria uma Oferta SDP (Session Description Protocol) e a define como descrição local.
         * Este é o primeiro passo do handshake WebRTC (o "convite").
         * @returns {Promise<RTCSessionDescriptionInit>} A oferta criada.
         * @throws {Error} Se a PeerConnection não tiver sido iniciada.
         */
        async createOffer() {
            if (!this.pc) throw new Error("PeerConnection não inicializada.");

            try {
                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);
                return offer;
            } catch (error) {
                console.error("SignalingService: Erro ao criar oferta WebRTC:", error);
                throw error;
            }
        }

        /**
         * Processa a Resposta (Answer) vinda do par remoto (Playback Tab).
         * Define a descrição remota para completar o handshake.
         * @param {RTCSessionDescriptionInit} answer - A resposta SDP recebida.
         */
        async handleAnswer(answer) {
            if (!this.pc) return;

            try {
                // Verificação de estado para evitar erros comuns de race condition
                // Só aceita resposta se estivermos esperando uma (have-local-offer)
                if (this.pc.signalingState === 'have-local-offer') {
                    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
                } else {
                    console.warn("SignalingService: Estado inválido para setRemoteDescription:", this.pc.signalingState);
                }
            } catch (error) {
                console.error("SignalingService: Erro ao definir resposta remota:", error);
            }
        }

        /**
         * Adiciona um Candidato ICE recebido do par remoto.
         * @param {RTCIceCandidateInit} candidate - O candidato de rede.
         */
        async handleCandidate(candidate) {
            if (!this.pc) return;

            try {
                // Adiciona o candidato à conexão para estabelecer o caminho de mídia
                await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error("SignalingService: Erro ao adicionar candidato ICE:", error);
            }
        }

        /**
         * Encerra a conexão WebRTC e limpa as referências.
         * Deve ser chamado ao final da gravação para liberar sockets e memória.
         */
        cleanup() {
            if (this.pc) {
                this.pc.close();
                this.pc = null;
            }
            this.localStream = null;
        }
    }

    // Exporta a classe para uso global no Content Script
    window.SoluttoSignalingService = SignalingService;

})();