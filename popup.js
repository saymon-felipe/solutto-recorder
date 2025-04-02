// Aguarda o carregamento do DOM para iniciar a aplicação
document.addEventListener("DOMContentLoaded", () => {
  showDocument();
});

// Listener para mensagens enviadas pelo runtime do Chrome
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openEditor") {
    // Armazena as configurações do vídeo e abre a página do editor
    chrome.storage.local.set({
      videoUrl: message.videoUrl,
      videoTimeout: message.videoTimeout
    }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
    });
  }

  if (message.action === "requestStream") {
    chrome.tabCapture.getMediaStreamId({ consumerTabId: message.tabId }, (streamId) => {
      sendResponse(streamId);
    })    

    return true;
  }
});

/**
 * Cria elementos <option> para cada dispositivo recebido.
 * @param {Array} devices - Lista de dispositivos (câmeras ou microfones).
 * @returns {Array} Array de elementos <option>.
 */
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

/**
 * Trunca o texto se ele exceder o limite especificado.
 * @param {string} texto - Texto a ser truncado.
 * @param {number} limite - Número máximo de caracteres permitidos (padrão: 40).
 * @returns {string} Texto possivelmente truncado com "..." ao final.
 */
function truncarTexto(texto, limite = 40) {
  return texto.length > limite ? texto.slice(0, limite) + "..." : texto;
}

/**
 * Adiciona um array de elementos como filhos de um elemento pai.
 * @param {HTMLElement} parent - Elemento pai.
 * @param {Array} elements - Array de elementos a serem adicionados.
 */
function appendElements(parent, elements) {
  elements.forEach(element => parent.appendChild(element));
}

/**
 * Preenche os campos de seleção com as listas de dispositivos disponíveis.
 * @param {Object} devices - Objeto contendo arrays de dispositivos:
 *                           - cameras: lista de câmeras.
 *                           - microfones: lista de microfones.
 */
function fillDevices(devices) {
  let camera = document.getElementById("camera");
  let microphone = document.getElementById("microphone");

  let cameraDevices = returnDevices(devices.cameras);
  let microphoneDevices = returnDevices(devices.microfones);

  appendElements(camera, cameraDevices);
  appendElements(microphone, microphoneDevices);

  // Após preencher as opções, retorna os valores armazenados anteriormente
  returnStoredOptions();
}

/**
 * Recupera as configurações armazenadas e define os valores dos campos correspondentes.
 */
function returnStoredOptions() {
  const cameraSelectElement = document.getElementById("camera");
  const microphoneSelectElement = document.getElementById("microphone");
  const waitSecondsElement = document.getElementById("wait-seconds");
  const timeoutCheckboxElement = document.getElementById("use-wait-seconds");

  chrome.storage.local.get("cameraSelect", (data) => {
    if (data.cameraSelect) {
      const optionExists = Array.from(cameraSelectElement.options).some(option => option.value === data.cameraSelect);

      if (optionExists) {
          cameraSelectElement.value = data.cameraSelect;
      } else {
        cameraSelectElement.value = "";
      }
    }
  });

  chrome.storage.local.get("microphoneSelect", (data) => {
    if (data.microphoneSelect) {
      const optionExists = Array.from(microphoneSelectElement.options).some(option => option.value === data.microphoneSelect);

      if (optionExists) {
        microphoneSelectElement.value = data.microphoneSelect;
      } else {
        microphoneSelectElement.value = "";
      }
    }
  });

  chrome.storage.local.get("optionsSelect", (data) => {
    if (data.optionsSelect) {
      let button = document.querySelector(".solutto-gravador .source[source='" + data.optionsSelect + "']");
      addEventListenerSelectTab(button);

      if (data.optionsSelect == "webcam") {
        setDefaultCameraOptions();
      }
    }
  });

  chrome.storage.local.get("timeoutCheckbox", (data) => {
    if (data.timeoutCheckbox != undefined) {
      timeoutCheckboxElement.checked = data.timeoutCheckbox;
    }
  });

  chrome.storage.local.get("waitSeconds", (data) => {
    if (data.waitSeconds) {
      waitSecondsElement.value = data.waitSeconds;
    }
  });
}

/**
 * Exibe a opção default da webcam para gravação de câmera.
 */
function setDefaultCameraOptions(callback = null) {
  const cameraSelectElement = document.getElementById("camera");

  if (cameraSelectElement.value == "") {
    const firstValidOption = Array.from(cameraSelectElement.options).find(option => option.value.trim() !== "");
    
    if (!firstValidOption) {
      if (confirm("Opção de gravação inválida. \n\n Nenhum dispositivo de vídeo encontrado.")) {
        cameraSelectElement.value = "";
        document.getElementById("video-config").value = "screen";
      }
    } else {
      cameraSelectElement.value = firstValidOption.value;

      if (callback) {
        callback();
      }
    }
  }
}

/**
 * Exibe o documento com efeito de fade-in e inicia a aplicação após um pequeno atraso.
 */
function showDocument() {
  setTimeout(() => {
    document.querySelector(".solutto-gravador").style.opacity = "1";

    setTimeout(() => {
      start();
    }, 400);
  }, 10);
}

/**
 * Função para inciar o event listener de seleção das abas de source de gravação.
 */
function addEventListenerSelectTab(button) {
  document.querySelectorAll(".solutto-gravador .source").forEach(button2 => {
    button2.classList.remove("selected");
  })

  button.classList.add("selected");
  let selector = document.querySelector(".solutto-gravador .selector-tab");

  let leftPosition = button.offsetLeft;
  let width = button.offsetWidth;

  selector.style.width = `${width}px`;
  selector.style.left = `${leftPosition}px`;
}

/**
 * Inicializa os listeners e configurações dos elementos da interface.
 */
function start() {
  const startVideoButton = document.getElementById("start-recording");
  const cameraSelectElement = document.getElementById("camera");
  const microphoneSelectElement = document.getElementById("microphone");
  const waitSecondsElement = document.getElementById("wait-seconds");
  const timeoutCheckboxElement = document.getElementById("use-wait-seconds");
  const wrapper = document.getElementById("solutto-recorder-wrapper");

  wrapper.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "kill" });
    });
  })

  // Atualiza o valor de "waitSeconds" no armazenamento local quando alterado
  waitSecondsElement.addEventListener("change", (e) => {
    let value = e.target.value;
    if (value.trim() !== "") {
      chrome.storage.local.set({ waitSeconds: value });
    }
  });

  // Atualiza o valor do checkbox de timeout no armazenamento local quando alterado
  timeoutCheckboxElement.addEventListener("change", (e) => {
    chrome.storage.local.set({ timeoutCheckbox: e.target.checked });
  });

  // Atualiza a seleção de câmera no armazenamento local quando alterada
  cameraSelectElement.addEventListener("change", (e) => {
    let value = e.target.value;
    if (value.trim() !== "") {
      chrome.storage.local.set({ cameraSelect: value });
    }
  });

  // Atualiza a seleção de microfone no armazenamento local quando alterada
  microphoneSelectElement.addEventListener("change", (e) => {
    let value = e.target.value;
    if (value.trim() !== "") {
      chrome.storage.local.set({ microphoneSelect: value });
    }
  });

  // Atualiza a opção de configuração de vídeo no armazenamento local quando alterada
  document.querySelectorAll(".solutto-gravador .source").forEach(button => {
    button.addEventListener("click", () => {
      addEventListenerSelectTab(button);

      let value = button.getAttribute("source");
      if (value.trim() !== "") {
        if (value == "webcam") {
          setDefaultCameraOptions(() => { chrome.storage.local.set({ optionsSelect: value }) });
        } else {
          chrome.storage.local.set({ optionsSelect: value });
        }      
      }
    });
  });

  // Inicia a gravação ao clicar no botão
  startVideoButton.addEventListener("click", () => {
    triggerRecording();
  });

  /**
   * Função para disparar o processo de gravação.
   * Coleta as configurações atuais e envia uma mensagem para a aba ativa solicitando a gravação.
   */
  function triggerRecording() {
    const recordingType = document.querySelector(".source.selected").getAttribute("source");
    const useTimeout = document.getElementById("use-wait-seconds").checked;
    const timeoutSeconds = document.getElementById("wait-seconds").value;

    // Define o timeout de gravação conforme a escolha do usuário
    let recordTimeout = useTimeout ? timeoutSeconds : 0;

    let microfoneId = document.getElementById("microphone").value || null;
    let webcamId = document.getElementById("camera").value || null;

    if (recordingType === "webcam" && !webcamId) {
      alert("Selecione uma câmera para gravar");
      return;
    }

    // Consulta a aba ativa para enviar a solicitação de gravação
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      

      chrome.tabs.sendMessage(tabs[0].id, {
        action: "request_recording",
        type: recordingType,
        microfoneId: microfoneId,
        webcamId: webcamId,
        timeout: recordTimeout,
        tabId: tabs[0].id
      }, (response) => {
        if (!chrome.runtime.lastError) {
          if (response.allow) {
            // Esconde os elementos da interface após iniciar a gravação
            document.querySelector(".wrapper").style.display = "none";
            document.querySelector(".container").style.display = "none";
          }
        } else {
          console.log(chrome.runtime.lastError, "Erro na linha 229");
        }
      });
    });
  }

  // Solicita a lista de dispositivos disponíveis da aba ativa e preenche os selects
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, { action: "request_devices" }, (response) => {
      if (!chrome.runtime.lastError) {
        fillDevices(response.devices);
      } else {
        console.log(chrome.runtime.lastError, "Erro na linha 241");
      }
    });
  });
}