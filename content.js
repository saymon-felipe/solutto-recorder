var recorder = null;
var isRecording = false;
var recordStream = null;
var recordTimeout = 0;

var elapsedSeconds = 0;
var timerInterval = null;
var isPaused = false;

if (!window.contentScriptInjected) {
    window.contentScriptInjected = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "removeContentScript") {
            delete window.contentScriptInjected; // Remove flag
            sendResponse({ success: true });
            return;
        }
    });

    injectFontAwesome();
    injectStyles();
}

function onAccessApproved(stream, timeout) {
    if (recorder) {
        console.log("Solutto Gravador: Uma gravação já está em andamento.");
        return;
    }

    recordStream = stream;

    recorder = new MediaRecorder(stream); // Agora a gravação é armazenada corretamente
    isRecording = true;
    recorder.start();
    console.log('Solutto Gravador: Gravação iniciada...');
    
    recorder.onstop = (fromHandle = false) => {
        stream.getTracks().forEach(track => {
            if (track.readyState == 'live') {
                track.stop();
            }
        });

        window.isRequestingScreen = false;
        isRecording = false;
        recordTimeout = 0;

        if (!fromHandle) {
            document.querySelector(".pause").click();
            document.getElementById("stop-recording").click();
        }
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
        zIndex: "9999",
        transition: "opacity 0.4s ease-in-out",
        opacity: "0"
    });
    document.body.appendChild(previewVideo);
    previewVideo.play();

    setTimeout(() => {
        previewVideo.style.opacity = "1";
    }, 10)
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
        zIndex: "9999",
        transition: "opacity 0.4s ease-in-out",
        opacity: "0"
    });
    document.body.appendChild(previewVideo);
    previewVideo.play();

    makeDraggable(previewVideo);

    setTimeout(() => {
        previewVideo.style.opacity = "1";
    }, 10)
}

function createTimeoutElement(timeoutSeconds) {
    if (document.getElementById("recorder-timeout")) {
        document.getElementById("recorder-timeout").remove();
    }

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
    timeoutDiv.style.transition = "opacity 0.4s ease-in-out";
    timeoutDiv.style.opacity = "0";

    const timeoutSpan = document.createElement("span");
    timeoutSpan.style.fontSize = "104px";
    timeoutSpan.style.fontWeight = "600";
    timeoutSpan.textContent = "3";

    timeoutDiv.appendChild(timeoutSpan);

    document.body.appendChild(timeoutDiv);

    setTimeout(() => {
        timeoutDiv.style.opacity = "1";
    }, 10)

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
                startTimer();
            }
        }, 1000)
    }
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

    if (message.action == "kill") {
        kill().then(() => {
            sendResponse("Killed");
        })

        return true;
    }

    if (message.action === "request_devices") {
        createRecorderControls();

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

            initRecordingInterface(message.timeout);
            sendResponse({ message: `Processed recording: ${message.action}`, allow: true });
        }).catch((error) => {
            sendResponse(error);
        })

        return true;
    }

    function initRecording() {
        return new Promise((resolve, reject) => {
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
                let trilhas = message.type == "screen" ? [...screenStream.getVideoTracks()] : [...recordOnlyWebcamStream.getVideoTracks()];

                if (message.type == "screen") {
                    if (microfoneStream) {
                        trilhas.push(...microfoneStream.getAudioTracks());
                    }

                    if (webcamStream) {
                        createWebcamElement(webcamStream);
                    }
                }

                if (message.type === "webcam") {
                    trilhas.push(...recordOnlyWebcamStream.getAudioTracks());
                    createVideoElement(recordOnlyWebcamStream);
                }

                const streamCombinado = new MediaStream(trilhas);

                onAccessApproved(streamCombinado, message.timeout);

                resolve();
            }).catch((error) => {
                window.isRequestingScreen = false;
                reject({ message: `Error: ${error.message}`, allow: false });
            })
        })
    }
});

function kill() {
    return new Promise((resolveMaster) => {
        let promises = [];

        if (document.getElementById("solutto-gravador-camera-preview")) {
            document.getElementById("solutto-gravador-camera-preview").style.opacity = 0; 
        }

        promises.push(
            new Promise((resolve) => {
                setTimeout(() => {
                    if (document.getElementById("solutto-gravador-camera-preview")) {
                        document.getElementById("solutto-gravador-camera-preview").remove();
                    }
                    
                    resolve();
                }, 400)
            })
        )

        if (document.getElementById("solutto-gravador-webcam-preview")) {
            document.getElementById("solutto-gravador-webcam-preview").style.opacity = 0;

            promises.push(
                new Promise((resolve) => {
                    setTimeout(() => {
                        if (document.getElementById("solutto-gravador-webcam-preview")) {
                            document.getElementById("solutto-gravador-webcam-preview").remove();
                        }
                        
                        resolve();
                    }, 400)
                })
            )
        }

        if (document.querySelector(".solutto-gravador-controls")) {
            document.querySelector(".solutto-gravador-controls").style.opacity = "0";

            promises.push(
                new Promise((resolve) => {
                    setTimeout(() => {
                        if (document.querySelector(".solutto-gravador-controls")) {
                            document.querySelector(".solutto-gravador-controls").remove();
                        }
                        
                        resolve();
                    }, 400)
                })
            )
        }

        Promise.all(promises).then(() => {
            if (document.querySelector("#solutto-gravador-iframe")) {
                document.querySelector("#solutto-gravador-iframe").remove();
            }

            recorder = null;
            isRecording = false;
            recordStream = null;
            recordTimeout = 0;
            elapsedSeconds = 0;
            clearInterval(timerInterval);
            timerInterval = null;
            isPaused = false;

            resolveMaster();
        })
    })
}

function injectFontAwesome() {
    if (document.getElementById("font-awesome-injected")) return; // Evita injeção duplicada

    const link = document.createElement("link");
    link.id = "font-awesome-injected"; // ID para evitar múltiplas injeções
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css";
    link.integrity = "sha512-Evv84Mr4kqVGRNSgIGL/F/aIDqQb7xQ2vcrdIwxfjThSH8CSR7PBEakCr51Ck+w+/U6swU2Im1vVX0SVk9ABhg==";
    link.crossOrigin = "anonymous";
    link.referrerpolicy = "no-referrer"

    document.head.appendChild(link);
}

function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
        .solutto-gravador-controls {
            position: fixed;
            bottom: 1rem;
            left: 3rem;
            background: #FAFAFA;
            border-radius: 8px;
            border: 1px solid #E6E6E6;
            padding: 7px 20px;
            z-index: 9999;
            display: flex;
            align-items: center;
            gap: 1rem;
            height: 59px;
            transition: opacity 0.4s ease-in-out;
            oapcity: 0;
        }

        .solutto-gravador-controls i {
            font-size: 23px;
            cursor: pointer;
        }

        .solutto-gravador-controls .elapsed-time {
            border-radius: 8px;
            background: #E6E6E6;
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 10px;
            color: #4D4D4D;
        }

        .solutto-gravador-controls .elapsed-time .play {
            display: none;
        }

        .solutto-gravador-controls .actions {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .solutto-gravador-controls .space {
            height: 22px;
            width: 2px;
            background: #E6E6E6;
        }

        .solutto-gravador-controls #grab-control {
            color: #999999;
        }

        .solutto-gravador-controls .rounded-btn {
            background: none;
            border: none;
        }

        .solutto-gravador-controls .rounded-btn:disabled i {
            color: #999999;
            cursor: default;
        }

        .solutto-gravador-controls .submit {
            color: #00AAB3;
        }

        .solutto-gravador-controls .delete {
            color: #FF0000;
        }
    `;

    document.head.appendChild(style);
}

function createRecorderControls() {
    if (document.querySelector(".solutto-gravador-controls")) {
        document.querySelector(".solutto-gravador-controls").remove();
    }

    const container = document.createElement("div");
    container.className = "solutto-gravador-controls";

    // Ícone de movimentação
    const grabControl = document.createElement("i");
    grabControl.className = "fa-solid fa-grip-vertical";
    grabControl.id = "grab-control";
    container.appendChild(grabControl);

    // Tempo decorrido
    const elapsedTime = document.createElement("div");
    elapsedTime.className = "elapsed-time";
    
    const timeSpan = document.createElement("span");
    timeSpan.id = "elapsed-time";
    timeSpan.innerHTML = "00:00:00";
    elapsedTime.appendChild(timeSpan);

    const playButton = document.createElement("button");
    playButton.className = "rounded-btn play";
    playButton.disabled = true;
    playButton.innerHTML = '<i class="fa-solid fa-circle-play"></i>';
    elapsedTime.appendChild(playButton);

    const pauseButton = document.createElement("button");
    pauseButton.className = "rounded-btn pause";
    pauseButton.disabled = true;
    pauseButton.innerHTML = '<i class="fa-solid fa-circle-pause"></i>';
    elapsedTime.appendChild(pauseButton);

    container.appendChild(elapsedTime);

    // Espaço
    const spaceDiv = document.createElement("div");
    spaceDiv.className = "space";
    container.appendChild(spaceDiv);

    // Ações
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "actions";

    const stopButton = document.createElement("button");
    stopButton.className = "rounded-btn submit";
    stopButton.id = "stop-recording";
    stopButton.disabled = true;
    stopButton.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
    actionsDiv.appendChild(stopButton);

    const deleteButton = document.createElement("button");
    deleteButton.className = "rounded-btn delete";
    deleteButton.id = "delete-recording";
    deleteButton.disabled = true;
    deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
    actionsDiv.appendChild(deleteButton);

    container.appendChild(actionsDiv);

    document.body.appendChild(container);

    container.style.opacity = "1";

    makeControlDraggable(container);
}

function formatTime(seconds) {
    const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
}

function startTimer() {
    if (timerInterval) return;
    
    isPaused = false;
    document.getElementById("elapsed-time").innerHTML = formatTime(elapsedSeconds);

    timerInterval = setInterval(() => {
        if (document.getElementById("elapsed-time")) {
            if (!isPaused) {
                elapsedSeconds++;
    
                let elapsedTimeElement = document.getElementById("elapsed-time");
    
                elapsedTimeElement.innerHTML = formatTime(elapsedSeconds);
            }
        } 
    }, 1000)
}

function pauseTimer() {
    isPaused = true;
}

function resumeTimer() {
    if (isPaused) {
        isPaused = false;
    }
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    elapsedSeconds = 0;
    isPaused = false;
    document.getElementById("elapsed-time").innerHTML = "00:00:00";
}

function openEditorTab(videoBlobUrl, recordTimeout, url) {
    chrome.runtime.sendMessage({ action: "openEditor", videoUrl: videoBlobUrl, videoTimeout: recordTimeout });
}

function initRecordingInterface(timeout) {
    document.getElementById("solutto-gravador-iframe").style.display = "none";

    setTimeout(() => {
      document.querySelector(".play").setAttribute("disabled", true);
      document.querySelector(".pause").removeAttribute("disabled");
      document.querySelector(".submit").setAttribute("disabled", true);
      document.querySelector(".delete").setAttribute("disabled", true);

      startTimer();
    }, timeout * 1000)

    const stopVideoButton = document.getElementById("stop-recording");
    const deleteVideoButton = document.getElementById("delete-recording");
    const pauseVideoButton = document.querySelector(".pause");
    const resumeVideoButton = document.querySelector(".play");

    stopVideoButton.addEventListener("click", () => {
        console.log("Solutto Gravador: Encerrando gravação");
    
        if (!recorder) {
            console.log("Solutto Gravador: Nenhum gravador ativo");
            return;
        }

        recorder.stop(true);

        recorder.ondataavailable = async (event) => {
            const blob = new Blob([event.data], { type: "video/webm" });
            const videoBlobUrl = URL.createObjectURL(blob);
    
            openEditorTab(videoBlobUrl, recordTimeout, "editor.html");

            document.querySelector(".play").setAttribute("disabled", true);
            document.querySelector(".pause").setAttribute("disabled", true);
            document.querySelector(".submit").setAttribute("disabled", true);
            document.querySelector(".delete").setAttribute("disabled", true);

            stopTimer();

            kill();
        };
    })

    deleteVideoButton.addEventListener("click", () => {
        if (confirm("Tem certeza que deseja excluir a gravação?")) {
            recorder.stop(true);

            kill();
        }
    })

    pauseVideoButton.addEventListener("click", () => {
        if (!recorder || recorder.state !== "recording") {
            return console.log("Solutto Gravador: Não é possível pausar, pois a gravação não está ativa");
        }

        recorder.pause();

        document.querySelector(".play").removeAttribute("disabled");
        document.querySelector(".pause").setAttribute("disabled", true);
        document.querySelector(".play").style.display = "block";
        document.querySelector(".pause").style.display = "none";
        document.getElementById("stop-recording").removeAttribute("disabled");
        document.querySelector(".delete").removeAttribute("disabled");

        pauseTimer();
    })

    resumeVideoButton.addEventListener("click", () => {
        if (!recorder || recorder.state !== "paused") {
            return console.log("Solutto Gravador: Não é possível retomar, pois a gravação não está pausada");
        }

        recorder.resume();

        document.querySelector(".play").setAttribute("disabled", true);
        document.querySelector(".pause").removeAttribute("disabled");
        document.querySelector(".play").style.display = "none";
        document.querySelector(".pause").style.display = "block";
        document.querySelector(".submit").setAttribute("disabled", true);
        document.querySelector(".delete").setAttribute("disabled", true);

        resumeTimer();
    })
  }

  function makeDraggable(element) {
    let offsetX, offsetY, isDragging = false;
  
    element.style.position = "fixed"; // Garante que pode ser movido
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

  function makeControlDraggable(element) {
    let offsetX, offsetY, isDragging = false;
  
    element.style.position = "fixed"; // Garante que pode ser movido
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
            element.style.left = event.clientX - offsetX + "px";
            element.style.top = event.clientY - offsetY + "px";
        }
    });
  
    document.addEventListener("mouseup", () => {
        isDragging = false;

        if (document.getElementById("grab-control")) {
            document.getElementById("grab-control").style.cursor = "grab";
        }
    });
  }