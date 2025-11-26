/**
 * PlaybackManager - Receptor WebRTC (Aba de Background).
 * * Esta classe roda dentro de uma aba invisível/fixada (playback.html).
 * Sua função principal é receber o stream de áudio da aba que está sendo gravada
 * e reproduzi-lo. Isso "engana" o Chrome para manter a captura de áudio ativa
 * e permite que o usuário ouça o som da aba (retorno de áudio).
 */

const ACTIONS = {
    OFFER: "offer",
    ANSWER: "answer",
    CANDIDATE: "candidate",
    READY_TO_RECEIVE: "ready-to-receive"
};

class PlaybackManager {
    constructor() {
        // Configuração STUN pública do Google para permitir conexão P2P local
        this.pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        
        // Fila para armazenar candidatos ICE que chegam antes da Oferta (Race Condition)
        this.pendingCandidates = [];
    }

    /**
     * Inicializa os listeners de eventos WebRTC e de Mensagens do Chrome.
     */
    init() {
        console.log("Solutto Playback: Inicializando receptor...");

        // Configura eventos do RTCPeerConnection
        this.pc.ontrack = (event) => this._handleTrack(event);
        this.pc.onicecandidate = (event) => this._handleIceCandidate(event);

        // Escuta mensagens vindas do Content Script (Sender)
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            // Processa sem await aqui para não bloquear a resposta síncrona do runtime
            this._handleMessage(msg);
            sendResponse({ received: true });
            return true;
        });

        // Avisa o background/content que esta aba está pronta para receber a chamada
        // O timeout garante que a página carregou totalmente
        setTimeout(() => {
             chrome.runtime.sendMessage({ action: ACTIONS.READY_TO_RECEIVE });
        }, 500);
    }

    /**
     * Chamado quando o WebRTC recebe uma trilha de mídia (Áudio).
     * Toca o áudio para garantir que a captura não seja interrompida pelo Chrome.
     * @param {RTCTrackEvent} event 
     */
    _handleTrack(event) {
        console.log("Solutto Playback: Áudio recebido.");
        const audio = new Audio();
        audio.srcObject = event.streams[0];
        
        // Volume 1.0 é essencial para que o usuário ouça o som da aba gravada
        // (já que a aba original foi mutada pelo chrome.tabCapture)
        audio.volume = 1.0; 
        
        audio.play().catch(e => console.warn("Autoplay impedido:", e));
    }

    /**
     * Envia candidatos ICE locais de volta para o emissor (Content Script).
     * @param {RTCPeerConnectionIceEvent} event 
     */
    _handleIceCandidate(event) {
        if (event.candidate) {
            chrome.runtime.sendMessage({
                action: ACTIONS.CANDIDATE,
                // Serializa o objeto para garantir que passe pela mensagem do Chrome sem perdas
                candidate: JSON.parse(JSON.stringify(event.candidate))
            });
        }
    }

    /**
     * Roteador de mensagens recebidas.
     * @param {Object} msg 
     */
    async _handleMessage(msg) {
        try {
            switch (msg.action) {
                case ACTIONS.OFFER:
                    await this._handleOffer(msg.offer);
                    break;
                case ACTIONS.CANDIDATE:
                    await this._handleRemoteCandidate(msg.candidate);
                    break;
            }
        } catch (error) {
            console.error("Solutto Playback: Erro na mensagem", msg.action, error);
        }
    }

    /**
     * Processa a Oferta SDP (Offer) recebida.
     * Configura a descrição remota, cria a resposta (Answer) e processa candidatos pendentes.
     * @param {RTCSessionDescriptionInit} offer 
     */
    async _handleOffer(offer) {
        // Verificação de segurança de estado
        if (this.pc.signalingState !== "stable") {
            console.warn("Recebi oferta mas o estado não é stable:", this.pc.signalingState);
        }

        console.log("Solutto Playback: Definindo Remote Description...");
        
        // 1. Define Oferta Remota
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));

        // Só cria a resposta se o estado mudou corretamente para 'have-remote-offer'
        if (this.pc.signalingState === "have-remote-offer") {
            console.log("Solutto Playback: Criando Answer...");
            
            // 2. Cria Resposta
            const answer = await this.pc.createAnswer();
            
            // 3. Define Descrição Local
            await this.pc.setLocalDescription(answer);

            // 4. Envia a resposta de volta para o Content Script
            chrome.runtime.sendMessage({ 
                action: ACTIONS.ANSWER, 
                answer: JSON.parse(JSON.stringify(answer)) 
            });

            // 5. Processa candidatos que chegaram antes da oferta (Race Condition)
            this._processPendingCandidates();
        } else {
            console.error("ERRO CRÍTICO: setRemoteDescription falhou ou estado inválido:", this.pc.signalingState);
        }
    }

    /**
     * Processa candidatos ICE remotos.
     * Se a conexão ainda não estiver estabelecida (RemoteDescription), enfileira.
     * @param {RTCIceCandidateInit} candidate 
     */
    async _handleRemoteCandidate(candidate) {
        if (!candidate) return;

        // Só adiciona candidato se já tivermos a descrição remota definida
        if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
            try {
                await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.warn("Erro ao adicionar ICE Candidate:", e);
            }
        } else {
            console.log("Guardando candidato para depois (Remote Description pendente)...");
            this.pendingCandidates.push(candidate);
        }
    }

    /**
     * Processa a fila de candidatos ICE pendentes.
     */
    async _processPendingCandidates() {
        console.log(`Processando ${this.pendingCandidates.length} candidatos da fila.`);
        for (const candidate of this.pendingCandidates) {
            try {
                await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.warn("Erro processando candidato pendente:", e);
            }
        }
        this.pendingCandidates = [];
    }
}

// Inicializa a instância
const manager = new PlaybackManager();
manager.init();