/*************************************
 * Variáveis e Flags Globais
 *************************************/
var recorder = null;
var isRecording = false;
var recordStream = null;
var recordTimeout = 0;

var elapsedSeconds = 0;
var timerInterval = null;
var isPaused = false;
var playbackTab = null;

var pc;
var localStream = null;
var pendingAnswer = null;
var recordType = null;

/*************************************
 * Injeção Única do Content Script
 *************************************/
// Garante que o content script seja injetado apenas uma vez na página
if (!window.contentScriptInjected) {
    window.contentScriptInjected = true;

    // Listener para remover o content script quando solicitado
    chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
        if (message.action === "removeContentScript") {
            delete window.contentScriptInjected; // Remove a flag de injeção
            
            sendResponse({ success: true });

            return;
        }

        try {
            if (message.action === 'answer') {
                if (pc && pc.signalingState === 'have-local-offer') {
                    await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
                } else {
                    pendingAnswer = message.answer; // salva pra aplicar depois
                }
            }
        
            if (message.action === 'candidate') {
                if (pc) {
                    await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
                }
            }
        } catch (error) {}
    });

    // Injeta dependências visuais: FontAwesome e estilos customizados
    injectFontAwesome();
    injectStyles();
}

window.addEventListener("beforeunload", (event) => {
    kill();
});  

/*************************************
 * Funções Relacionadas à Gravação
 *************************************/

/**
 * Callback chamada quando o acesso à mídia é aprovado.
 * Inicia a gravação com a stream combinada.
 *
 * @param {MediaStream} stream - Stream de mídia combinada (vídeo, áudio e/ou webcam).
 */
function onAccessApproved(stream, timeout) {
    if (recorder) {
        console.log("Solutto Recorder: Uma gravação já está em andamento.");
        return;
    }

    recordStream = stream;
    recorder = new MediaRecorder(stream);
   
    setTimeout(() => {
        recorder.start();
        isRecording = true;
        console.log('Solutto Recorder: Gravação iniciada...');
    }, timeout * 1000)

    // Quando a gravação for parada, interrompe todas as tracks da stream
    recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());

        const localAudioClone = stream.clone();
        const localAudioElement = new Audio();
        localAudioElement.srcObject = localAudioClone;
        localAudioElement.volume = 1;
        localAudioElement.play();

        window.isRequestingScreen = false;
        isRecording = false;
        recordTimeout = 0;

        stopExistingStreams();
    };
}

/**
 * Cria e exibe um elemento de vídeo para pré-visualização (modo tela ou webcam).
 *
 * @param {MediaStream} stream - Stream de mídia para exibição.
 */
function createVideoElement(stream) {
    const existingControls = document.querySelectorAll("#solutto-recorder-camera-preview");
    existingControls.forEach((element) => {
        element.remove();
    });

    let previewVideo = document.createElement("video");
    previewVideo.srcObject = stream;
    previewVideo.setAttribute("id", "solutto-recorder-camera-preview");
    previewVideo.setAttribute("autoplay", true);
    previewVideo.setAttribute("playsinline", true);
    previewVideo.muted = true; // Para permitir autoplay sem interação
    Object.assign(previewVideo.style, {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        left: "0",
        margin: "auto",
        width: "90vw",
        maxWidth: "1200px",
        borderRadius: "1rem",
        background: "white",
        padding: "2rem",
        border: "1px solid #E6E6E6",
        zIndex: "9998",
        transition: "opacity 0.4s ease-in-out",
        opacity: "0"
    });
    document.body.appendChild(previewVideo);
    previewVideo.play();

    setTimeout(() => {
        previewVideo.style.opacity = "1";
    }, 10);
}

/**
 * Cria e exibe um elemento de vídeo para pré-visualização da webcam (em sobreposição).
 *
 * @param {MediaStream} stream - Stream da webcam.
 */
function createWebcamElement(stream) {
    const existingControls = document.querySelectorAll("#solutto-recorder-webcam-preview");
    existingControls.forEach((element) => {
        element.remove();
    });

    let previewVideo = document.createElement("video");
    previewVideo.srcObject = stream;
    previewVideo.setAttribute("id", "solutto-recorder-webcam-preview");
    previewVideo.setAttribute("autoplay", true);
    previewVideo.setAttribute("playsinline", true);
    previewVideo.muted = true;
    Object.assign(previewVideo.style, {
        position: "fixed",
        top: "5rem",
        left: "5rem",
        height: "200px",
        width: "200px",
        objectFit: "cover",
        borderRadius: "50%",
        zIndex: "9999",
        transition: "opacity 0.4s ease-in-out",
        opacity: "0"
    });
    document.body.appendChild(previewVideo);
    previewVideo.play();

    makeDraggable(previewVideo);

    setTimeout(() => {
        previewVideo.style.opacity = "1";
    }, 10);
}

/**
 * Cria e exibe um elemento de timeout visual para indicar a contagem regressiva.
 *
 * @param {number} timeoutSeconds - Tempo inicial para o timeout.
 */
function createTimeoutElement(timeoutSeconds) {
    // Remove elemento existente, se houver
    const existingControls = document.querySelectorAll("#recorder-timeout");
    existingControls.forEach((element) => {
        element.remove();
    });

    const timeoutDiv = document.createElement("div");
    timeoutDiv.setAttribute("id", "recorder-timeout");
    Object.assign(timeoutDiv.style, {
        width: "300px",
        height: "300px",
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        position: "fixed",
        zIndex: "999999",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        margin: "auto",
        background: "#00aab3",
        color: "white",
        transition: "opacity 0.4s ease-in-out",
        opacity: "0"
    });

    const timeoutSpan = document.createElement("span");
    timeoutSpan.style.fontSize = "104px";
    timeoutSpan.style.fontWeight = "600";
    timeoutSpan.textContent = "3";
    timeoutDiv.appendChild(timeoutSpan);

    document.body.appendChild(timeoutDiv);

    setTimeout(() => {
        timeoutDiv.style.opacity = "1";
    }, 10);

    if (timeoutSeconds > 0) {
        timeoutDiv.style.display = "grid";
        timeoutSpan.innerHTML = timeoutSeconds;

        let count = parseInt(timeoutSeconds);
        timeoutSpan.innerHTML = count;
        count--;

        let interval = setInterval(() => {
            if (count > 0) {
                timeoutSpan.innerHTML = count;
                count--;
            } else {
                clearInterval(interval);
                timeoutDiv.style.display = "none";
                startTimer();
            }
        }, 1000);
    }
}

/*************************************
 * Listener para Mensagens do Background
 *************************************/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    /***************************************************
     * Funções Auxiliares Locais para Manipulação de Mídia
     ***************************************************/

    async function pedirPermissaoMidia() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            stream.getTracks().forEach(track => track.stop());
            return stream;
        } catch (error) {
            console.error("❌ Permissão negada ou erro ao acessar dispositivos:", error);
        }
    }

    async function listarDispositivosMidia() {
        try {
            // Verifica se já há permissão para câmera ou microfone
            const cameraPerm = await navigator.permissions.query({ name: "camera" });
            const micPerm = await navigator.permissions.query({ name: "microphone" });

            let precisaPermissao = cameraPerm.state !== "granted" || micPerm.state !== "granted";

            // Se precisar da permissão, solicita e encerra imediatamente
            if (precisaPermissao) {
                await pedirPermissaoMidia();
            }

            const dispositivos = await navigator.mediaDevices.enumerateDevices();
            const cameras = dispositivos.filter(device => device.kind === "videoinput");
            const microfones = dispositivos.filter(device => device.kind === "audioinput");
            return { cameras, microfones };
        } catch (error) {
            console.error("Erro ao listar dispositivos de mídia:", error);
        }
    }

    /***************************************************
     * Tratamento de Ações via Mensagens
     ***************************************************/
    if (message.action == "kill") {
        kill().then(() => {
            sendResponse("Killed");
        });
        return true;
    }

    if (message.action === "request_devices") {
        // Cria controles de gravação e retorna os dispositivos disponíveis
        createRecorderControls();
        listarDispositivosMidia().then(dispositivos => {
            let devices = {
                cameras: dispositivos.cameras,
                microfones: dispositivos.microfones
            };
            sendResponse({ devices: devices });
        });
        return true;
    }

    if (message.action === "request_recording") {
        // Impede início de nova gravação se já houver uma em andamento
        if (isRecording || recorder || window.isRequestingScreen) {
            return;
        }

        window.isRequestingScreen = true;

        initRecording(message.timeout).then(() => {
            if (message.timeout > 0) {
                recordTimeout = message.timeout;
                createTimeoutElement(message.timeout);
            }

            initRecordingInterface(message.timeout);

            sendResponse({ message: `Processed recording: ${message.action}`, allow: true });
        }).catch((error) => {
            sendResponse(error);
        });
        return true;
    }

    function initPlaybackRTC(stream) {
        pc = new RTCPeerConnection();

        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        localStream = stream;

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                chrome.runtime.sendMessage({ action: 'candidate', candidate: event.candidate });
            }
        };

        (async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                chrome.runtime.sendMessage({ action: 'offer', offer });

                // Se já tiver uma answer recebida antes do offer, aplica agora
                if (pendingAnswer) {
                    await pc.setRemoteDescription(new RTCSessionDescription(pendingAnswer));
                    pendingAnswer = null;
                }
            } catch (err) {
                console.error("Erro ao iniciar WebRTC:", err);
            }
        })();
    }

    /**
     * Inicia a gravação com base no tipo solicitado.
     * Suporta gravação de tela (screen) ou apenas da webcam.
     *
     * @returns {Promise} Resolvida quando as streams são obtidas e combinadas.
     */
    function initRecording(timeout) {
        return new Promise(async (resolve, reject) => {
            let mediaPromise = [];
            let screenStream, microfoneStream, webcamStream, recordOnlyWebcamStream, screenAudioStream;

            if (message.type === "screen" || message.type === "tab") {
                if (message.type === "tab") {
                    recordType = message.type;
                    let openedPlaybackObj = await chrome.runtime.sendMessage({ action: "openPlaybackTab" });
                    let streamId = await chrome.runtime.sendMessage({ action: "requestStream", tabId: message.tabId });

                    let constraints = {
                        audio: {
                            mandatory: {
                                chromeMediaSource: "tab",
                                chromeMediaSourceId: streamId,
                            }
                        },
                        video: {
                            mandatory: {
                                chromeMediaSource: "tab",
                                chromeMediaSourceId: streamId,
                                maxWidth: 99999999,
                                maxHeight: 99999999,
                                maxFrameRate: 30
                            }
                        }
                    }    

                    screenStream = await navigator.mediaDevices.getUserMedia(constraints);
                    screenAudioStream = screenStream.getAudioTracks();

                    initPlaybackRTC(screenStream);

                    playbackTab = openedPlaybackObj.playbackTab;

                    mediaPromise.push( new Promise((resolve) => { resolve() }) );
                } else {
                    mediaPromise.push(
                        navigator.mediaDevices.getDisplayMedia({
                            audio: true,
                            video: { 
                                width: 999999999, 
                                height: 999999999,
                                displaySurface: "monitor"
                            }
                        }).then((stream) => { 
                            screenStream = stream; 
                            screenAudioStream = stream.getAudioTracks();
                        })
                    )
                }                

                // Se o ID do microfone foi informado, solicita a captura do áudio
                if (message.microfoneId) {
                    mediaPromise.push(
                        navigator.mediaDevices.getUserMedia({
                            audio: message.microfoneId ? { deviceId: { exact: message.microfoneId } } : false
                        }).then((stream) => { microfoneStream = stream; })
                    );
                }
                // Se o ID da webcam foi informado, solicita a captura do vídeo da webcam
                if (message.webcamId) {
                    mediaPromise.push(
                        navigator.mediaDevices.getUserMedia({
                            video: message.webcamId ? { deviceId: { exact: message.webcamId } } : true
                        }).then((stream) => { webcamStream = stream; })
                    );
                }
            } else if (message.type === "webcam") {
                // Para gravação apenas da webcam, interrompe streams existentes e solicita nova captura
                mediaPromise.push(
                    stopExistingStreams().then(() => {
                        return navigator.mediaDevices.getUserMedia({
                            video: message.webcamId ? { deviceId: { exact: message.webcamId } } : true,
                            audio: message.microfoneId ? { deviceId: { exact: message.microfoneId } } : false
                        }).then((stream) => { recordOnlyWebcamStream = stream; });
                    })
                );
            } else {
                sendResponse("Erro: Tipo de gravação inválido.");
                return false;
            }

            async function mixAudioStreams(stream1, stream2) {
                const context = new AudioContext();
                const destination = context.createMediaStreamDestination();
                
                [stream1, stream2].forEach((stream) => {
                    const source = context.createMediaStreamSource(stream);
                    source.connect(destination);
                });
                
                return destination.stream;
            }

            Promise.all(mediaPromise).then(async () => {
                // Combina as tracks de vídeo (e áudio, se houver) conforme o tipo de gravação
                let trilhas = message.type === "screen" || message.type === "tab" ? [...screenStream.getVideoTracks()] : [...recordOnlyWebcamStream.getVideoTracks()];
                if (message.type === "screen" || message.type === "tab") {
                    if (screenAudioStream && microfoneStream) {
                        const audioMix = await mixAudioStreams(
                            new MediaStream(screenAudioStream),
                            microfoneStream
                        );
                        trilhas.push(...audioMix.getAudioTracks());
                    } else if (screenAudioStream) {
                        trilhas.push(...screenAudioStream);
                    } else if (microfoneStream) {
                        trilhas.push(...microfoneStream.getAudioTracks());
                    }
                    
                    if (webcamStream) {
                        createWebcamElement(webcamStream);
                    }

                    //Listener para o botão de parar compartilhamento
                    screenStream.getVideoTracks()[0].addEventListener("ended", () => {
                        document.querySelector(".pause").click();

                        setTimeout(() => {
                            document.getElementById("stop-recording").click();
                        }, 10)
                    });
                }
                if (message.type === "webcam") {
                    trilhas.push(...recordOnlyWebcamStream.getAudioTracks());
                    createVideoElement(recordOnlyWebcamStream);
                }

                const streamCombinado = new MediaStream(trilhas);
                onAccessApproved(streamCombinado, timeout);
                resolve();
            }).catch((error) => {
                window.isRequestingScreen = false;
                reject({ message: `Error: ${error.message}`, allow: false });
            });
        });
    }
});

/*************************************
 * Função para Encerrar a Gravação e Limpar a Interface
 *************************************/
/**
 * Finaliza a gravação, remove elementos de pré-visualização e controles,
 * e reseta variáveis globais.
 *
 * @returns {Promise} Resolvida após a limpeza completa da interface.
 */

async function stopExistingStreams() {
    // Versão local que interrompe tanto vídeo quanto áudio
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices.forEach(device => {
        if (device.kind === "videoinput") {
            navigator.mediaDevices.getUserMedia({ video: true })
                .then(stream => {
                    stream.getTracks().forEach(track => track.stop());
                })
                .catch(error => console.warn("Erro ao liberar câmera:", error));
        }
        if (device.kind === "audioinput") {
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    stream.getTracks().forEach(track => track.stop());
                })
                .catch(error => console.warn("Erro ao liberar microfone:", error));
        }
    });
}

function kill() {
    return new Promise((resolveMaster) => {
        let promises = [];

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }

        // Função auxiliar para ocultar e remover múltiplos elementos
        function removeElements(selector) {
            const elements = document.querySelectorAll(selector);
            elements.forEach((element) => {
                element.style.opacity = "0";
                promises.push(
                    new Promise((resolve) => {                        
                        setTimeout(() => {
                            element.remove();

                            resolve();
                        }, 400);
                    })
                );
            });
        }

        closeTabs();

        // Oculta e remove os elementos necessários
        removeElements("#solutto-recorder-camera-preview");
        removeElements("#solutto-recorder-webcam-preview");
        removeElements("#solutto-recorder-controls");

        // Interrompe os streams existentes
        promises.push(stopExistingStreams());

        if (recorder) {
            recorder.stop();
            recorder = null;
        }

        // Aguarda todas as promessas serem resolvidas antes de concluir
        Promise.all(promises).then(() => {
            const existingIframe = document.querySelectorAll("#solutto-recorder-iframe");
            existingIframe.forEach((element) => {
                element.remove();
            });

            // Reseta variáveis globais e limpa intervalos
            recorder = null;
            isRecording = false;
            recordStream = null;
            recordTimeout = 0;
            elapsedSeconds = 0;
            clearInterval(timerInterval);
            timerInterval = null;
            isPaused = false;

            resolveMaster();
        });
    });
}

/*************************************
 * Funções de Injeção de Estilos e FontAwesome
 *************************************/
/**
 * Injeta o FontAwesome na página para uso dos ícones.
 */
function injectFontAwesome() {
    if (document.getElementById("font-awesome-injected")) return;
    const link = document.createElement("link");
    link.id = "font-awesome-injected";
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css";
    link.integrity = "sha512-Evv84Mr4kqVGRNSgIGL/F/aIDqQb7xQ2vcrdIwxfjThSH8CSR7PBEakCr51Ck+w+/U6swU2Im1vVX0SVk9ABhg==";
    link.crossOrigin = "anonymous";
    link.referrerpolicy = "no-referrer";
    document.head.prepend(link);
}

/**
 * Injeta estilos customizados para os controles do gravador.
 */
function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
        #solutto-recorder-controls {
            position: fixed;
            bottom: 1rem;
            left: 3rem;
            background: #FAFAFA;
            border-radius: 8px;
            border: 1px solid #E6E6E6;
            padding: 7px 20px;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 1rem;
            height: 59px;
            transition: opacity 0.4s ease-in-out;
            opacity: 0;
        }
        #solutto-recorder-controls i {
            font-size: 23px;
            cursor: pointer;
            font-family: "Font Awesome 6 Free" !important; 
            font-weight: 900; 
            content: attr(data-icon);
        }
        #solutto-recorder-controls .elapsed-time {
            border-radius: 8px;
            background: #E6E6E6;
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 10px;
            color: #4D4D4D;
        }
        #solutto-recorder-controls .elapsed-time .play {
            display: none;
        }
        #solutto-recorder-controls .actions {
            display: flex;
            align-items: center;
            gap: 1rem;
        }
        #solutto-recorder-controls .space {
            height: 22px;
            width: 2px;
            background: #E6E6E6;
        }
        #solutto-recorder-controls #grab-control {
            color: #999999;
        }
        #solutto-recorder-controls .solutto-rounded-btn {
            background: none;
            border: none;
            display: grid;
        }
        #solutto-recorder-controls .solutto-rounded-btn:disabled i {
            color: #999999;
            cursor: default;
        }
        #solutto-recorder-controls .submit {
            color: #00AAB3;
        }
        #solutto-recorder-controls .delete {
            color: #FF0000;
        }
    `;
    document.head.appendChild(style);
}

/*************************************
 * Criação dos Controles de Gravação
 *************************************/
/**
 * Cria e insere na página os controles para manipulação da gravação.
 */
function createRecorderControls() {
    const existingControls = document.querySelectorAll("#solutto-recorder-controls");
    existingControls.forEach((element) => {
        element.remove();
    });

    const container = document.createElement("div");
    container.id = "solutto-recorder-controls";

    // Ícone para mover os controles
    const grabControl = document.createElement("i");
    grabControl.className = "fa-solid fa-grip-vertical";
    grabControl.id = "grab-control";
    container.appendChild(grabControl);

    // Exibição do tempo decorrido
    const elapsedTime = document.createElement("div");
    elapsedTime.className = "elapsed-time";
    const timeSpan = document.createElement("span");
    timeSpan.id = "elapsed-time";
    timeSpan.innerHTML = "00:00:00";
    elapsedTime.appendChild(timeSpan);

    // Botões para pausar e retomar a gravação
    const playButton = document.createElement("button");
    playButton.className = "solutto-rounded-btn play";
    playButton.disabled = true;
    playButton.innerHTML = '<i class="fa-solid fa-circle-play"></i>';
    elapsedTime.appendChild(playButton);

    const pauseButton = document.createElement("button");
    pauseButton.className = "solutto-rounded-btn pause";
    pauseButton.disabled = true;
    pauseButton.innerHTML = '<i class="fa-solid fa-circle-pause"></i>';
    elapsedTime.appendChild(pauseButton);

    container.appendChild(elapsedTime);

    // Espaço separador
    const spaceDiv = document.createElement("div");
    spaceDiv.className = "space";
    container.appendChild(spaceDiv);

    // Botões de ações: parar e excluir gravação
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "actions";

    const stopButton = document.createElement("button");
    stopButton.className = "solutto-rounded-btn submit";
    stopButton.id = "stop-recording";
    stopButton.disabled = true;
    stopButton.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
    actionsDiv.appendChild(stopButton);

    const deleteButton = document.createElement("button");
    deleteButton.className = "solutto-rounded-btn delete";
    deleteButton.id = "delete-recording";
    deleteButton.disabled = true;
    deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
    actionsDiv.appendChild(deleteButton);

    container.appendChild(actionsDiv);
    document.body.appendChild(container);
    container.style.opacity = "1";

    makeControlDraggable(container);
}

/*************************************
 * Funções de Timer (Contagem de Tempo)
 *************************************/
/**
 * Formata segundos em "hh:mm:ss".
 *
 * @param {number} seconds - Tempo em segundos.
 * @returns {string} Tempo formatado.
 */
function formatTime(seconds) {
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
}

/**
 * Inicia a contagem do tempo decorrido da gravação.
 */
function startTimer() {
    if (timerInterval) return;
    isPaused = false;
    document.getElementById("elapsed-time").innerHTML = formatTime(elapsedSeconds);
    timerInterval = setInterval(() => {
        if (document.getElementById("elapsed-time") && !isPaused) {
            elapsedSeconds++;
            document.getElementById("elapsed-time").innerHTML = formatTime(elapsedSeconds);
        }
    }, 1000);
}

/**
 * Pausa a contagem do tempo.
 */
function pauseTimer() {
    isPaused = true;
}

/**
 * Retoma a contagem do tempo se estiver pausada.
 */
function resumeTimer() {
    if (isPaused) {
        isPaused = false;
    }
}

/**
 * Para a contagem do tempo e reseta os valores.
 */
function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    elapsedSeconds = 0;
    isPaused = false;
    document.getElementById("elapsed-time").innerHTML = "00:00:00";
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]); // Remove "data:mime;base64,"
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/*************************************
 * Funções para Ações na Interface
 *************************************/
/**
 * Abre a aba do editor enviando a URL do blob e o timeout.
 *
 * @param {string} videoBlobUrl - URL do blob do vídeo.
 * @param {number} recordTimeout - Timeout definido.
 */
async function openEditorTab(videoBlobUrl, recordTimeout) {    
    chrome.runtime.sendMessage({ action: "openEditor", videoUrl: videoBlobUrl, videoTimeout: recordTimeout });

    closePlaybackTab();
}

function closePlaybackTab() {
    if (recordType == "tab") {
        chrome.runtime.sendMessage({ action: "closePlaybackTab", playbackTab: playbackTab });
    }
}

function closeTabs() {
    chrome.runtime.sendMessage({ action: "closeTabs" });
}

/**
 * Inicializa a interface de gravação (configura botões, timers e listeners)
 *
 * @param {number} timeout - Timeout em segundos antes de habilitar os controles.
 */
function initRecordingInterface(timeout) {
    // Esconde o iframe do gravador
    const existingIframe = document.querySelectorAll("#solutto-recorder-iframe");
    existingIframe.forEach((element) => {
        element.style.display = "none";
    });

    setTimeout(() => {
        document.querySelector(".play").setAttribute("disabled", true);
        document.querySelector(".pause").removeAttribute("disabled");
        document.querySelector(".submit").setAttribute("disabled", true);
        document.querySelector(".delete").setAttribute("disabled", true);

        if (timeout == 0) {
            startTimer();
        }
    }, timeout * 1000);

    const stopVideoButton = document.getElementById("stop-recording");
    const deleteVideoButton = document.getElementById("delete-recording");
    const pauseVideoButton = document.querySelector(".pause");
    const resumeVideoButton = document.querySelector(".play");

    // Listener para encerrar a gravação
    stopVideoButton.addEventListener("click", () => {
        console.log("Solutto Recorder: Encerrando gravação");
        if (!recorder) {
            console.log("Solutto Recorder: Nenhum gravador ativo");
            return;
        }

        recorder.stop();

        recorder.ondataavailable = async (event) => {
            const blob = new Blob([event.data], { type: "video/webm" });
            const videoBlobUrl = URL.createObjectURL(blob);

            openEditorTab(videoBlobUrl, recordTimeout, blob);

            // Desabilita controles após finalizar
            document.querySelector(".play").setAttribute("disabled", true);
            document.querySelector(".pause").setAttribute("disabled", true);
            document.querySelector(".submit").setAttribute("disabled", true);
            document.querySelector(".delete").setAttribute("disabled", true);

            stopTimer();
            kill();
        };
    });

    // Listener para excluir a gravação
    deleteVideoButton.addEventListener("click", () => {
        if (confirm("Tem certeza que deseja excluir a gravação?")) {
            recorder.stop();
            kill();
        }
    });

    // Listener para pausar a gravação
    pauseVideoButton.addEventListener("click", () => {
        if (!recorder || recorder.state !== "recording") {
            return console.log("Solutto Recorder: Não é possível pausar, pois a gravação não está ativa");
        }
        recorder.pause();
        document.querySelector(".play").removeAttribute("disabled");
        document.querySelector(".pause").setAttribute("disabled", true);
        document.querySelector(".play").style.display = "grid";
        document.querySelector(".pause").style.display = "none";
        document.getElementById("stop-recording").removeAttribute("disabled");
        document.querySelector(".delete").removeAttribute("disabled");
        pauseTimer();
    });

    // Listener para retomar a gravação pausada
    resumeVideoButton.addEventListener("click", () => {
        if (!recorder || recorder.state !== "paused") {
            return console.log("Solutto Recorder: Não é possível retomar, pois a gravação não está pausada");
        }
        recorder.resume();
        document.querySelector(".play").setAttribute("disabled", true);
        document.querySelector(".pause").removeAttribute("disabled");
        document.querySelector(".play").style.display = "none";
        document.querySelector(".pause").style.display = "grid";
        document.querySelector(".submit").setAttribute("disabled", true);
        document.querySelector(".delete").setAttribute("disabled", true);
        resumeTimer();
    });
}

/*************************************
 * Funções para Tornar Elementos Arrastáveis
 *************************************/
/**
 * Torna um elemento qualquer arrastável.
 *
 * @param {HTMLElement} element - Elemento a ser arrastado.
 */
function makeDraggable(element) {
    let offsetX, offsetY, isDragging = false;
    element.style.position = "fixed"; // Necessário para movimentação
    element.style.cursor = "grab";

    element.addEventListener("mousedown", (event) => {
        isDragging = true;
        offsetX = event.clientX - element.getBoundingClientRect().left;
        offsetY = event.clientY - element.getBoundingClientRect().top;
        element.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (event) => {
        if (isDragging) {
            element.style.left = (event.clientX - offsetX) + "px";
            element.style.top = (event.clientY - offsetY) + "px";
        }
    });

    document.addEventListener("mouseup", () => {
        isDragging = false;
        element.style.cursor = "grab";
    });
}

/**
 * Torna os controles de gravação arrastáveis a partir do ícone de "grab".
 *
 * @param {HTMLElement} element - Container dos controles.
 */
function makeControlDraggable(element) {
    let offsetX, offsetY, isDragging = false;
    element.style.position = "fixed";
    document.getElementById("grab-control").style.cursor = "grab";

    document.addEventListener("mousedown", (event) => {
        const grabControl = event.target.closest("#grab-control");
        if (grabControl) {
            isDragging = true;
            offsetX = event.clientX - element.getBoundingClientRect().left;
            offsetY = event.clientY - element.getBoundingClientRect().top;
            grabControl.style.cursor = "grabbing";
        }
    });

    document.addEventListener("mousemove", (event) => {
        if (isDragging) {
            element.style.left = (event.clientX - offsetX) + "px";
            element.style.top = (event.clientY - offsetY) + "px";
        }
    });

    document.addEventListener("mouseup", () => {
        isDragging = false;
        if (document.getElementById("grab-control")) {
            document.getElementById("grab-control").style.cursor = "grab";
        }
    });
}