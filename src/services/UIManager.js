/**
 * UIManager - Gerenciador de Interface do Usuário (Content Script).
 * Responsável por injetar e controlar elementos visuais flutuantes na página do usuário,
 * como os botões de controle (Play/Pause/Stop), contagem regressiva e preview da webcam.
 * * Utiliza uma estratégia "No-Shadow" (injeção direta no DOM) para garantir compatibilidade máxima
 * com fontes e eventos, mas aplica um CSS reset agressivo e IDs únicos para evitar conflitos.
 */
(function () {
    const Utils = window.SoluttoUtils;
    const C = window.SoluttoConstants;

    // --- ÍCONES SVG ---
    // Definidos inline para eliminar dependência de carregamento de fontes externas (CORS/CSP)
    const ICONS = {
        GRIP: `<svg viewBox="0 0 14 20" width="10" height="16" fill="currentColor"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="10" r="2"/><circle cx="4" cy="16" r="2"/><circle cx="10" cy="4" r="2"/><circle cx="10" cy="10" r="2"/><circle cx="10" cy="16" r="2"/></svg>`,
        PAUSE: `<svg viewBox="0 0 320 512" width="18" height="18" fill="currentColor"><path d="M48 64C21.5 64 0 85.5 0 112V400c0 26.5 21.5 48 48 48H80c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48H48zm192 0c-26.5 0-48 21.5-48 48V400c0 26.5 21.5 48 48 48h32c26.5 0 48-21.5 48-48V112c0-26.5-21.5-48-48-48H240z"/></svg>`,
        PLAY: `<svg viewBox="0 0 384 512" width="18" height="18" fill="currentColor"><path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80V432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"/></svg>`,
        STOP: `<svg viewBox="0 0 512 512" width="22" height="22" fill="currentColor"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM192 160H320c17.7 0 32 14.3 32 32V320c0 17.7-14.3 32-32 32H192c-17.7 0-32-14.3-32-32V192c0-17.7 14.3-32 32-32z"/></svg>`,
        TRASH: `<svg viewBox="0 0 448 512" width="18" height="18" fill="currentColor"><path d="M135.2 17.7L128 32H32C14.3 32 0 46.3 0 64S14.3 96 32 96H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320l-7.2-14.3C307.4 6.8 296.3 0 284.2 0H163.8c-12.1 0-23.2 6.8-28.6 17.7zM416 128H32L53.2 467c1.6 25.3 22.6 45 47.9 45H346.9c25.3 0 46.3-19.7 47.9-45L416 128z"/></svg>`
    };

    const LARGE_PREVIEW_ID = "solutto-recorder-large-preview";

    // Helper para Trusted Types (necessário para injetar HTML em sites como YouTube/Facebook)
    let trustedTypesPolicy = null;
    function getTrustedHTML(htmlString) {
        if (window.trustedTypes && window.trustedTypes.createPolicy) {
            if (!trustedTypesPolicy) {
                try {
                    trustedTypesPolicy = window.trustedTypes.createPolicy('soluttoRecorderPolicy', {
                        createHTML: (string) => string,
                    });
                } catch (e) { console.warn("Policy error:", e); }
            }
            if (trustedTypesPolicy) return trustedTypesPolicy.createHTML(htmlString);
        }
        return htmlString;
    }

    class SoluttoUI {
        constructor() {
            this.container = null;
            this.isDragging = false;
        }

        static getInstance() {
            if (!window.SoluttoUIInstance) window.SoluttoUIInstance = new SoluttoUI();
            return window.SoluttoUIInstance;
        }

        /**
         * Inicializa o container principal no DOM da página.
         * Cria uma DIV isolada com z-index máximo.
         */
        async init() {
            if (this.container) return;

            this.container = document.createElement("div");
            this.container.id = "solutto-recorder-wrapper-v3";
            
            Object.assign(this.container.style, {
                all: "initial", position: "fixed", zIndex: 2147483647,
                top: 0, left: 0, width: 0, height: 0,
                fontFamily: "sans-serif", lineHeight: "1.5"
            });

            document.body.appendChild(this.container);
            this._injectGlobalStyles();
        }

        /**
         * Injeta os estilos CSS globais da UI na página.
         * Usa uma tag <style> com ID único para evitar duplicação.
         */
        _injectGlobalStyles() {
            if (document.getElementById("solutto-styles")) return;
            const style = document.createElement("style");
            style.id = "solutto-styles";
            
            style.textContent = `
                @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
                
                /* CONTROLES FLUTUANTES */
                #${C.UI.CONTROLS_ID} {
                    position: fixed; bottom: 2rem; left: 2rem; background: #FAFAFA;
                    border-radius: 12px; border: 1px solid #E6E6E6; padding: 8px 16px;
                    z-index: 2147483647; display: flex; align-items: center; gap: 12px; height: 60px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.1); font-family: 'Roboto', sans-serif;
                    opacity: 0; transition: opacity 0.4s ease-in-out; box-sizing: border-box;
                }
                #${C.UI.CONTROLS_ID} * { box-sizing: border-box; }

                #grab-control { color: #999; display: flex; align-items: center; padding: 4px; cursor: grab; }
                .elapsed-time {
                    background: #E6E6E6; border-radius: 8px; padding: 8px 12px; display: flex;
                    align-items: center; gap: 10px; color: #4D4D4D; font-weight: 500; 
                    font-variant-numeric: tabular-nums; font-size: 14px;
                }
                .solutto-rounded-btn {
                    background: none; border: none; cursor: pointer; display: grid; place-items: center;
                    padding: 0; transition: transform 0.1s; width: 30px; height: 30px;
                }
                .solutto-rounded-btn:active { transform: scale(0.95); }
                
                .pause svg, .play svg { fill: #555; }
                .submit svg { fill: #00AAB3; }
                .delete svg { fill: #FF4444; }
                .space { width: 1px; height: 24px; background: #DDD; margin: 0 4px; }
                .actions { display: flex; align-items: center; gap: 12px; }
                
                /* PREVIEW WEBCAM (PIP - Canto Superior Esquerdo) */
                #${C.UI.WEBCAM_PREVIEW_ID} {
                    position: fixed; 
                    top: 2rem;  /* Posição alterada para o topo */
                    left: 2rem; 
                    width: 200px; height: 200px;
                    border-radius: 50%; object-fit: cover; box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                    border: 4px solid white; z-index: 2147483646; opacity: 0; transition: opacity 0.4s;
                }

                /* PREVIEW GRANDE (MODO ESPELHO - Webcam Only) */
                #${LARGE_PREVIEW_ID} {
                    position: fixed;
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%); /* Centralizado */
                    width: 60vw; max-width: 1000px; aspect-ratio: 16 / 9;
                    border-radius: 16px; object-fit: cover;
                    box-shadow: 0 20px 50px rgba(0,0,0,0.3);
                    border: 1px solid #444; background: #000;
                    z-index: 2147483645; /* Abaixo dos controles */
                    opacity: 0; transition: opacity 0.4s;
                }

                /* CONTAGEM REGRESSIVA (Overlay) */
                #${C.UI.COUNTDOWN_ID} {
                    position: fixed; inset: 0; margin: auto; width: 200px; height: 200px;
                    background: #00AAB3; border-radius: 50%; display: grid; place-items: center;
                    color: white; font-size: 100px; font-weight: bold; font-family: sans-serif;
                    box-shadow: 0 10px 30px rgba(0, 170, 179, 0.4); opacity: 0; transition: opacity 0.4s; z-index: 2147483647;
                }
            `;
            document.head.appendChild(style);
        }

        /**
         * Exibe a contagem regressiva em tela cheia.
         * @param {number} seconds 
         */
        async showCountdown(seconds) {
            await this.init();
            const container = document.createElement("div");
            container.id = C.UI.COUNTDOWN_ID;
            container.innerHTML = getTrustedHTML(`<span>${seconds}</span>`);
            this.container.appendChild(container);
            
            await Utils.nextFrame();
            container.style.opacity = "1";
            for (let i = seconds; i > 0; i--) {
                container.querySelector("span").innerText = i;
                await Utils.sleep(1000);
            }
            container.style.opacity = "0";
            await Utils.sleep(400);
            container.remove();
        }

        /**
         * Renderiza a barra de controles flutuante.
         * @param {Function} onActionCallback - Função chamada ao clicar nos botões.
         */
        async showControls(onActionCallback) {
            await this.init();
            if (document.getElementById(C.UI.CONTROLS_ID)) return;

            const controls = document.createElement("div");
            controls.id = C.UI.CONTROLS_ID;
            
            const htmlContent = `
                <div id="grab-control" title="Arrastar">
                    ${ICONS.GRIP}
                </div>
                <div class="elapsed-time">
                    <span id="timer-display">00:00:00</span>
                    <button class="solutto-rounded-btn pause" id="btn-pause" title="Pausar">${ICONS.PAUSE}</button>
                    <button class="solutto-rounded-btn play" id="btn-resume" title="Retomar" style="display: none;">${ICONS.PLAY}</button>
                </div>
                <div class="space"></div>
                <div class="actions">
                    <button class="solutto-rounded-btn submit" id="btn-stop" title="Finalizar">${ICONS.STOP}</button>
                    <button class="solutto-rounded-btn delete" id="btn-delete" title="Cancelar">${ICONS.TRASH}</button>
                </div>
            `;
            
            controls.innerHTML = getTrustedHTML(htmlContent);
            this.container.appendChild(controls);
            this._makeDraggable(controls);
            this._bindEvents(controls, onActionCallback);
            await Utils.nextFrame();
            controls.style.opacity = "1";
        }

        updateTimer(seconds) {
            const display = document.getElementById("timer-display");
            if (display) display.innerText = Utils.formatTime(seconds);
        }

        togglePauseState(isPaused) {
            const btnPause = document.getElementById("btn-pause");
            const btnResume = document.getElementById("btn-resume");
            if (!btnPause || !btnResume) return;
            btnPause.style.display = isPaused ? "none" : "grid";
            btnResume.style.display = isPaused ? "grid" : "none";
        }

        /**
         * Exibe a webcam flutuante (PIP).
         */
        async showWebcamPreview(stream) {
            await this.init();
            const old = document.getElementById(C.UI.WEBCAM_PREVIEW_ID);
            if (old) old.remove();
            const video = document.createElement("video");
            video.id = C.UI.WEBCAM_PREVIEW_ID;
            video.srcObject = stream;
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            this.container.appendChild(video);
            this._makeDraggable(video);
            await Utils.nextFrame();
            video.style.opacity = "1";
        }

        /**
         * Exibe a webcam em modo espelho (Grande/Centralizado).
         * Usado quando o usuário grava apenas a câmera.
         */
        async showLargeWebcamPreview(stream) {
            await this.init();
            const old = document.getElementById(LARGE_PREVIEW_ID);
            if (old) old.remove();

            const video = document.createElement("video");
            video.id = LARGE_PREVIEW_ID;
            video.srcObject = stream;
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            
            this.container.appendChild(video);
            this._makeDraggable(video); // Permite arrastar se estiver atrapalhando
            
            await Utils.nextFrame();
            video.style.opacity = "1";
        }

        /**
         * Remove todos os elementos da UI e limpa o container.
         */
        async cleanup() {
            const controls = document.getElementById(C.UI.CONTROLS_ID);
            const webcam = document.getElementById(C.UI.WEBCAM_PREVIEW_ID);
            const largeWebcam = document.getElementById(LARGE_PREVIEW_ID);
            
            const promises = [];
            
            if (controls) { controls.style.opacity = "0"; promises.push(Utils.sleep(400).then(() => controls.remove())); }
            if (webcam) { webcam.style.opacity = "0"; promises.push(Utils.sleep(400).then(() => webcam.remove())); }
            if (largeWebcam) { largeWebcam.style.opacity = "0"; promises.push(Utils.sleep(400).then(() => largeWebcam.remove())); }
            
            await Promise.all(promises);
            
            if (this.container) { this.container.remove(); this.container = null; }
            const st = document.getElementById("solutto-styles");
            if(st) st.remove();
        }

        _bindEvents(container, callback) {
            container.querySelector("#btn-stop").onclick = () => callback(C.ACTIONS.STOP_RECORDING);
            container.querySelector("#btn-pause").onclick = () => callback("pause");
            container.querySelector("#btn-resume").onclick = () => callback("resume");
            container.querySelector("#btn-delete").onclick = () => { if(confirm("Cancelar gravação?")) callback(C.ACTIONS.CANCEL_RECORDING); };
        }

        _makeDraggable(element) {
            let offsetX, offsetY;
            const grabber = element.querySelector("#grab-control") || element;
            grabber.style.cursor = "grab";
            const onMouseDown = (e) => {
                e.preventDefault();
                this.isDragging = true;
                grabber.style.cursor = "grabbing";
                const rect = element.getBoundingClientRect();
                // Calcula offset real considerando a posição atual
                offsetX = e.clientX - rect.left;
                offsetY = e.clientY - rect.top;
                document.addEventListener("mousemove", onMouseMove);
                document.addEventListener("mouseup", onMouseUp);
            };
            const onMouseMove = (e) => {
                if (!this.isDragging) return;
                // Remove transforms (como translate(-50%)) para mover livremente por top/left
                element.style.transform = 'none';
                element.style.left = `${e.clientX - offsetX}px`;
                element.style.top = `${e.clientY - offsetY}px`;
            };
            const onMouseUp = () => {
                this.isDragging = false;
                grabber.style.cursor = "grab";
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
            };
            grabber.addEventListener("mousedown", onMouseDown);
        }
    }

    window.SoluttoUIManager = SoluttoUI;
})();