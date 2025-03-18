document.addEventListener("DOMContentLoaded", () => {
  showDocument();
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openEditor") {
    chrome.storage.local.set({ videoUrl: message.videoUrl, videoTimeout: message.videoTimeout }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
    });
  }
});

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

  returnStoredOptions();
}

function returnStoredOptions() {
  const cameraSelectElement = document.getElementById("camera");
  const microphoneSelectElement = document.getElementById("microphone");
  const recordSource = document.getElementById("video-config");
  const waitSecondsElement = document.getElementById("wait-seconds");
  const timeoutCheckboxElement = document.getElementById("use-wait-seconds");

  chrome.storage.local.get("cameraSelect", (data) => {
    if (data.cameraSelect) {
      cameraSelectElement.value = data.cameraSelect;
    }
  })

  chrome.storage.local.get("microphoneSelect", (data) => {
    if (data.microphoneSelect) {
      microphoneSelectElement.value = data.microphoneSelect;
    }
  })

  chrome.storage.local.get("optionsSelect", (data) => {
    if (data.optionsSelect) {
      recordSource.value = data.optionsSelect;
    }
  })

  chrome.storage.local.get("timeoutCheckbox", (data) => {
    if (data.timeoutCheckbox != undefined) {
      timeoutCheckboxElement.checked = data.timeoutCheckbox;
    }
  })

  chrome.storage.local.get("waitSeconds", (data) => {
    if (data.waitSeconds) {
      waitSecondsElement.value = data.waitSeconds;
    }
  })
}

function showDocument() {
  setTimeout(() => {
    document.querySelector(".solutto-gravador").style.opacity = "1";

    setTimeout(() => {
      start();
    }, 400)
  }, 10)
}

function start() {
  const startVideoButton = document.getElementById("start-recording");
  const cameraSelectElement = document.getElementById("camera");
  const microphoneSelectElement = document.getElementById("microphone");
  const recordSource = document.getElementById("video-config");
  const waitSecondsElement = document.getElementById("wait-seconds");
  const timeoutCheckboxElement = document.getElementById("use-wait-seconds");

  waitSecondsElement.addEventListener("change", (e) => {
    let value = e.target.value;

    if (value.trim() != "") {
      chrome.storage.local.set({ waitSeconds: value });
    }
  })

  timeoutCheckboxElement.addEventListener("change", (e) => {
    chrome.storage.local.set({ timeoutCheckbox: e.target.checked });
  })

  cameraSelectElement.addEventListener("change", (e) => {
    let value = e.target.value;

    if (value.trim() != "") {
      chrome.storage.local.set({ cameraSelect: value });
    }
  })

  microphoneSelectElement.addEventListener("change", (e) => {
    let value = e.target.value;

    if (value.trim() != "") {
      chrome.storage.local.set({ microphoneSelect: value });
    }
  })

  recordSource.addEventListener("change", (e) => {
    let value = e.target.value;

    if (value.trim() != "") {
      chrome.storage.local.set({ optionsSelect: value });
    }
  })

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
          console.log(response.message);

          if (response.allow) {
            document.querySelector(".wrapper").style.display = "none";
            document.querySelector(".container").style.display = "none";
          }          
        } else {
          console.log(chrome.runtime.lastError, "Erro na linha 71");
        }
      })
    })
  }

  chrome.tabs.query({ active: true, currentWindow: true}, (tabs) => {
    chrome.tabs.sendMessage(tabs[0].id, { action: "request_devices" }, (response) => {
      if (!chrome.runtime.lastError) {
        fillDevices(response.devices);
      } else {
        console.log(chrome.runtime.lastError, "Erro na linha 82");
      }
    })
  })
}