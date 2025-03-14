var recorder = null;
var isRecording = false;
var recordStream = null;
var recordTimeout = 0;

if (!window.contentScriptInjected) {
    window.contentScriptInjected = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "removeContentScript") {
            console.log("Removendo content script...");
            delete window.contentScriptInjected; // Remove flag
            sendResponse({ success: true });
            return;
        }
    });

    console.log("Content script injetado.");
}

function onAccessApproved(stream, timeout) {
    if (recorder) {
        console.log("Uma gravação já está em andamento.");
        return;
    }

    recordStream = stream;

    recorder = new MediaRecorder(stream); // Agora a gravação é armazenada corretamente
    isRecording = true;
    recorder.start();
    console.log('Gravação iniciada...');
    
    recorder.onstop = () => {
        stream.getTracks().forEach(track => {
            if (track.readyState == 'live') {
                track.stop();
            }
        });

        window.isRequestingScreen = false;
        isRecording = false;
        recordTimeout = 0;
    };
}

async function stopExistingStreams() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  
  devices.forEach(device => {
      if (device.kind === "videoinput") {
          navigator.mediaDevices.getUserMedia({ video: true })
              .then(stream => {
                  stream.getTracks().forEach(track => track.stop());
              })
              .catch(error => console.warn("Erro ao liberar câmera:", error));
      }
  });
}

function createVideoElement(stream) {
    let previewVideo = document.createElement("video");
    previewVideo.srcObject = stream;
    previewVideo.setAttribute("id", "solutto-gravador-camera-preview");
    previewVideo.setAttribute("autoplay", true);
    previewVideo.setAttribute("playsinline", true);
    previewVideo.muted = true; // Silencia o vídeo para permitir autoplay sem interação
    Object.assign(previewVideo.style, {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        left: "0",
        margin: "auto",
        height: "80vh",
        borderRadius: "1rem",
        background: "white",
        padding: "2rem",
        border: "1px solid #E6E6E6",
        zIndex: "9999"
    });
    document.body.appendChild(previewVideo);
    previewVideo.play();
}

function createWebcamElement(stream) {
    let previewVideo = document.createElement("video");
    previewVideo.srcObject = stream;
    previewVideo.setAttribute("id", "solutto-gravador-webcam-preview");
    previewVideo.setAttribute("autoplay", true);
    previewVideo.setAttribute("playsinline", true);
    previewVideo.muted = true; // Silencia o vídeo para permitir autoplay sem interação
    Object.assign(previewVideo.style, {
        position: "fixed",
        top: "5rem",
        left: "5rem",
        height: "200px",
        width: "200px",
        objectFit: "cover",
        borderRadius: "50%",
        zIndex: "9999"
    });
    document.body.appendChild(previewVideo);
    previewVideo.play();

    makeDraggable(previewVideo);
}

function createTimeoutElement(timeoutSeconds) {
    const timeoutDiv = document.createElement("div");
    timeoutDiv.setAttribute("id", "recorder-timeout");
    timeoutDiv.style.width = "300px";
    timeoutDiv.style.height = "300px";
    timeoutDiv.style.borderRadius = "50%";
    timeoutDiv.style.display = "grid";
    timeoutDiv.style.placeItems = "center";
    timeoutDiv.style.position = "fixed";
    timeoutDiv.style.zIndex = "999999";
    timeoutDiv.style.top = "0";
    timeoutDiv.style.left = "0";
    timeoutDiv.style.right = "0";
    timeoutDiv.style.bottom = "0";
    timeoutDiv.style.margin = "auto";
    timeoutDiv.style.background = "#00aab3";
    timeoutDiv.style.color = "white";
    timeoutDiv.style.display = "none";

    const timeoutSpan = document.createElement("span");
    timeoutSpan.style.fontSize = "104px";
    timeoutSpan.style.fontWeight = "600";
    timeoutSpan.textContent = "3";

    timeoutDiv.appendChild(timeoutSpan);

    document.body.appendChild(timeoutDiv);

    if (timeoutSeconds > 0) {
        document.getElementById("recorder-timeout").style.display = "grid";
        document.querySelector("#recorder-timeout span").innerHTML = timeoutSeconds;

        let count = parseInt(timeoutSeconds);
        
        document.querySelector("#recorder-timeout span").innerHTML = count;
        count--;

        let interval = setInterval(() => {
            if (count > 0) {
                document.querySelector("#recorder-timeout span").innerHTML = count;
                count--;
            } else {
                clearInterval(interval);
                document.getElementById("recorder-timeout").style.display = "none";
            }
        }, 1000)
    }
}

function makeDraggable(element) {
    let offsetX, offsetY, isDragging = false;
  
    element.style.position = "absolute"; // Garante que pode ser movido
    element.style.cursor = "grab";
  
    element.addEventListener("mousedown", (event) => {
        isDragging = true;
        offsetX = event.clientX - element.getBoundingClientRect().left;
        offsetY = event.clientY - element.getBoundingClientRect().top;
        element.style.cursor = "grabbing";
    });
  
    document.addEventListener("mousemove", (event) => {
        if (isDragging) {
            element.style.left = event.clientX - offsetX + "px";
            element.style.top = event.clientY - offsetY + "px";
        }
    });
  
    document.addEventListener("mouseup", () => {
        isDragging = false;
        element.style.cursor = "grab";
    });
  }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  async function stopExistingStreams() {
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

    async function pedirPermissaoMidia() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            console.log("✅ Permissão concedida para câmera e microfone!");
            return stream;
        } catch (error) {
            console.error("❌ Permissão negada ou erro ao acessar dispositivos:", error);
        }
    }

    async function listarDispositivosMidia() {
        try {
            pedirPermissaoMidia();

            const dispositivos = await navigator.mediaDevices.enumerateDevices();
            const cameras = dispositivos.filter(device => device.kind === "videoinput");
            const microfones = dispositivos.filter(device => device.kind === "audioinput");
    
            return { cameras, microfones };
        } catch (error) {
            console.error("Erro ao listar dispositivos de mídia:", error);
        }
    }

    if (message.action === "request_devices") {
        listarDispositivosMidia().then(dispositivos => {
            let devices = {
                cameras: dispositivos.cameras,
                microfones: dispositivos.microfones
            }

            sendResponse({ devices: devices });
        });

        return true;
    }

    if (message.action === "request_recording") {

        if (isRecording || recorder || window.isRequestingScreen) {
            return;
        }

        window.isRequestingScreen = true;

        initRecording().then(() => {
            if (message.timeout > 0) {
                recordTimeout = message.timeout;
                createTimeoutElement(message.timeout);
            }
        })

        return true;
    }

    function initRecording() {
        return new Promise((resolve) => {
            let mediaPromise = [];

            let screenStream, microfoneStream, webcamStream, recordOnlyWebcamStream;

            if (message.type === "screen") {
                mediaPromise.push(
                    navigator.mediaDevices.getDisplayMedia({
                        audio: true,
                        video: {
                            width: 999999999,
                            height: 999999999
                        }
                    }).then((stream) => { screenStream = stream })
                )

                if (message.microfoneId) {
                    mediaPromise.push(
                        navigator.mediaDevices.getUserMedia({
                            audio: { deviceId: { exact: message.microfoneId } }
                        }).then((stream) => { microfoneStream = stream })
                    )
                }

                if (message.webcamId) {
                    mediaPromise.push(
                        navigator.mediaDevices.getUserMedia({
                            video: { deviceId: { exact: message.webcamId } }
                        }).then((stream) => { webcamStream = stream })
                    )
                }            
            } else if (message.type === "webcam") {
                mediaPromise.push(
                    stopExistingStreams().then(() => {
                        return navigator.mediaDevices.getUserMedia({
                            video: true,
                            audio: true
                        }).then((stream) => { recordOnlyWebcamStream = stream })
                    })
                )
            } else {
                sendResponse("Erro: Tipo de gravação inválido.");
                return false;
            }

            Promise.all(mediaPromise).then(() => {
                const trilhas = [...screenStream.getVideoTracks()];

                if (message.type == "screen") {
                    if (microfoneStream) {
                        trilhas.push(...microfoneStream.getAudioTracks());
                    }

                    if (webcamStream) {
                        createWebcamElement(webcamStream);
                    }
                }

                const streamCombinado = new MediaStream(trilhas);

                onAccessApproved(streamCombinado, message.timeout);

                if (message.type === "webcam") {
                    createVideoElement(recordOnlyWebcamStream);
                }
                
                sendResponse(`Processed recording: ${message.action}`);

                resolve();
            }).catch((error) => {
                console.error("Erro ao acessar a mídia:", error);
                window.isRequestingScreen = false;
                sendResponse(`Error: ${error.message}`);
            })
        })
    }

    if (message.action === "stopvideo") {
        console.log("Encerrando gravação");
    
        if (!recorder) {
            sendResponse({ error: "Nenhum gravador ativo" });
            return;
        }

        recorder.stop();

        recorder.ondataavailable = async (event) => {
            const blob = new Blob([event.data], { type: "video/webm" });
            const videoBlobUrl = URL.createObjectURL(blob);
    
            setTimeout(() => {
                console.log("Killing...");
                kill();
            }, 1500);
    
            sendResponse({ videoBlobUrl: videoBlobUrl, timeout: recordTimeout });
        };
        
        return true;
    }

    if (message.action === "deletevideo") {
        recorder.stop();

        kill();

        sendResponse(`Processed: ${message.action}`);
    }

    if (message.action === "pausevideo") {
        sendResponse(`Processed: ${message.action}`);

        if (!recorder || recorder.state !== "recording") {
            return console.log("Não é possível pausar, pois a gravação não está ativa");
        }

        recorder.pause();
        console.log("Gravação pausada...");
    }

    if (message.action === "resumevideo") {
        sendResponse(`Processed: ${message.action}`);

        if (!recorder || recorder.state !== "paused") {
            return console.log("Não é possível retomar, pois a gravação não está pausada");
        }

        recorder.resume();
        console.log("Gravação retomada...");
    }
});

function kill() {
    if (document.getElementById("solutto-gravador-camera-preview")) {
        document.getElementById("solutto-gravador-camera-preview").remove();
    }

    if (document.getElementById("solutto-gravador-webcam-preview")) {
        document.getElementById("solutto-gravador-webcam-preview").remove();
    }

    if (document.querySelector("#solutto-gravador-iframe")) {
        document.querySelector("#solutto-gravador-iframe").remove();
    }
}

async function cortarInicioDoVideo(blob, segundosParaRemover = 3) {
    return new Promise((resolve, reject) => {
        console.log("Auto editing before send...")
        const video = document.createElement("video");
        video.src = URL.createObjectURL(blob);
        video.muted = true;
        video.play();

        video.onloadedmetadata = () => {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");

            const mediaStream = canvas.captureStream();
            const recorder = new MediaRecorder(mediaStream, { mimeType: 'video/webm' });
            let trimmedChunks = [];

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    trimmedChunks.push(event.data);
                }
            };

            recorder.onstop = () => {
                const trimmedBlob = new Blob(trimmedChunks, { type: 'video/webm' });
                console.log("Edited, sending...")
                resolve(trimmedBlob);
            };

            recorder.start();

            setTimeout(() => {
                video.currentTime = segundosParaRemover; // Avança 3 segundos
                const drawInterval = setInterval(() => {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                }, 33); // Desenha no canvas a cada frame (~30 FPS)

                setTimeout(() => {
                    clearInterval(drawInterval);
                    recorder.stop();
                }, (video.duration - segundosParaRemover) * 1000);
            }, 100);
        };
    });
}