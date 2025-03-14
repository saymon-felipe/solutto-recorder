document.addEventListener("DOMContentLoaded", () => {
  const startVideoButton = document.getElementById("start-recording");
  const stopVideoButton = document.getElementById("stop-recording");
  const deleteVideoButton = document.getElementById("delete-recording");
  const pauseVideoButton = document.querySelector(".pause");
  const resumeVideoButton = document.querySelector(".play");

  let elapsedSeconds = 0;
  let timerInterval = null;
  let isPaused = false;

  function formatTime(seconds) {
      const hrs = String(Math.floor(seconds / 3600)).padStart(2, "0");
      const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
      const secs = String(seconds % 60).padStart(2, "0");
      return `${hrs}:${mins}:${secs}`;
  }

  function startTimer() {
      if (timerInterval) return; // Evita iniciar múltiplos intervalos

      isPaused = false;
      document.getElementById("elapsed-time").textContent = formatTime(elapsedSeconds);

      timerInterval = setInterval(() => {
          if (!isPaused) {
              elapsedSeconds++;
              document.getElementById("elapsed-time").textContent = formatTime(elapsedSeconds);
          }
      }, 1000);
  }

  function pauseTimer() {
      isPaused = true;
  }

  function resumeTimer() {
      if (isPaused) {
          isPaused = false;
      }
  }

  // Para parar completamente o temporizador
  function stopTimer() {
      clearInterval(timerInterval);
      timerInterval = null;
      elapsedSeconds = 0;
      isPaused = false;
      document.getElementById("elapsed-time").textContent = "00:00:00";
  }

  startVideoButton.addEventListener("click", () => {
    triggerRecording();
  })

  function triggerRecording() {
    const recordingType = document.getElementById("video-config").value;
    const useTimeout = document.getElementById("use-wait-seconds").checked;
    const timeoutSeconds = document.getElementById("wait-seconds").value;

    let recordTimeout = useTimeout ? timeoutSeconds : 0;

    chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
      let microfoneId = document.getElementById("microphone").value || null;
      let webcamId = document.getElementById("camera").value || null;

      chrome.tabs.sendMessage(tabs[0].id, { action: "request_recording", type: recordingType, microfoneId: microfoneId, webcamId: webcamId, timeout: recordTimeout }, (response) => {
        if (!chrome.runtime.lastError) {
          console.log(response);

          setTimeout(() => {
            initRecordingInterface();
          }, recordTimeout * 1000)
        } else {
          console.log(chrome.runtime.lastError, "Erro na linha 16");
        }
      })
    })
  }

  function initRecordingInterface() {
    document.querySelector(".play").setAttribute("disabled", true);
    document.querySelector(".pause").removeAttribute("disabled");
    document.querySelector(".submit").setAttribute("disabled", true);
    document.querySelector(".delete").setAttribute("disabled", true);
    document.querySelector(".wrapper").style.display = "none";
    document.querySelector(".container").style.display = "none";

    startTimer();
  }

  stopVideoButton.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "stopvideo" }, (response) => {
        if (!chrome.runtime.lastError) {
          console.log(response);
          document.querySelector(".play").setAttribute("disabled", true);
          document.querySelector(".pause").setAttribute("disabled", true);
          document.querySelector(".submit").setAttribute("disabled", true);
          document.querySelector(".delete").setAttribute("disabled", true);

          stopTimer();

          chrome.storage.local.set({ videoUrl: response.videoBlobUrl, videoTimeout: response.timeout }, () => {
            console.log("URL do vídeo salva no storage");

            // Criar a nova aba com editor.html
            chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
          });
        } else {
          console.log(chrome.runtime.lastError, "Erro na linha 30");
        }
      })
    })
  })

  deleteVideoButton.addEventListener("click", () => {
    if (confirm("Tem certeza que deseja excluir a gravação?")) {
      chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "deletevideo" }, (response) => {
          if (!chrome.runtime.lastError) {
            console.log(response);
            console.log("Saindo...");
          } else {
            console.log(chrome.runtime.lastError, "Erro na linha 30");
          }
        })
      })
    }
  })

  pauseVideoButton.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "pausevideo" }, (response) => {
        if (!chrome.runtime.lastError) {
          console.log(response);
          document.querySelector(".play").removeAttribute("disabled");
          document.querySelector(".pause").setAttribute("disabled", true);
          document.querySelector(".play").style.display = "block";
          document.querySelector(".pause").style.display = "none";
          document.querySelector(".submit").removeAttribute("disabled");
          document.querySelector(".delete").removeAttribute("disabled");

          pauseTimer();
        } else {
          console.log(chrome.runtime.lastError, "Erro na linha 30");
        }
      })
    })
  })

  resumeVideoButton.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "resumevideo" }, (response) => {
        if (!chrome.runtime.lastError) {
          console.log(response);
          document.querySelector(".play").setAttribute("disabled", true);
          document.querySelector(".pause").removeAttribute("disabled");
          document.querySelector(".play").style.display = "none";
          document.querySelector(".pause").style.display = "block";
          document.querySelector(".submit").setAttribute("disabled", true);
          document.querySelector(".delete").setAttribute("disabled", true);

          resumeTimer();
        } else {
          console.log(chrome.runtime.lastError, "Erro na linha 30");
        }
      })
    })
  })

  chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, { action: "request_devices" }, (response) => {
      if (!chrome.runtime.lastError) {
        fillDevices(response.devices);
      } else {
        console.log(chrome.runtime.lastError, "Erro na linha 160");
      }
    })
  })

  const myElement = document.querySelector(".controls");
  makeDraggable(myElement);
})

function makeDraggable(element) {
  let offsetX, offsetY, isDragging = false;

  element.style.position = "absolute"; // Garante que pode ser movido
  document.getElementById("grab-control").style.cursor = "grab";

  document.getElementById("grab-control").addEventListener("mousedown", (event) => {
      isDragging = true;
      offsetX = event.clientX - element.getBoundingClientRect().left;
      offsetY = event.clientY - element.getBoundingClientRect().top;
      document.getElementById("grab-control").style.cursor = "grabbing";
  });

  document.addEventListener("mousemove", (event) => {
      if (isDragging) {
          element.style.left = event.clientX - offsetX + "px";
          element.style.top = event.clientY - offsetY + "px";
      }
  });

  document.addEventListener("mouseup", () => {
      isDragging = false;
      document.getElementById("grab-control").style.cursor = "grab";
  });
}

function returnDevices(devices) {
  let devicesOptions = [];

  for (let i = 0; i < devices.length; i++) {
    let currentDevice = devices[i];
    let option = document.createElement("option");
    option.value = currentDevice.deviceId;
    option.innerHTML = truncarTexto(currentDevice.label);

    devicesOptions.push(option);
  }

  return devicesOptions;
}

function truncarTexto(texto, limite = 40) {
  return texto.length > limite ? texto.slice(0, limite) + "..." : texto;
}

function appendElements(parent, elements) {
  elements.forEach(element => parent.appendChild(element));
}

function fillDevices(devices) {
  let camera = document.getElementById("camera");
  let microphone = document.getElementById("microphone");

  let cameraDevices = returnDevices(devices.cameras);
  let microphoneDevices = returnDevices(devices.microfones);

  appendElements(camera, cameraDevices);
  appendElements(microphone, microphoneDevices);
}