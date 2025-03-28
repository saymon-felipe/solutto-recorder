var downloadRequested = false;

// Recupera as configurações do vídeo armazenadas no Chrome Storage
chrome.storage.local.get(["videoUrl", "videoTimeout"], async (data) => {
    const videoUrl = data.videoUrl;
    // Define o tempo de espera (timeout) com valor padrão 0 se não estiver definido
    const videoTimeout = data.videoTimeout || 0;

    // Se houver uma URL de vídeo armazenada, inicia o carregamento e configuração do player
    if (videoUrl) {
        const videoElement = document.getElementById("video");
        const loadingElement = document.querySelector(".loading");

        // Habilita os controles do elemento de vídeo
        videoElement.controls = true;

        loadingElement.style.display = "block";

        // Transcodifica o vídeo para o formato MP4, aplicando o timeout, e define a URL resultante como fonte do vídeo
        videoElement.src = await transcode(videoUrl, "mp4", videoTimeout);

        // Define um atributo customizado para indicar o formato do arquivo
        videoElement.setAttribute("file-format", "mp4");

        // Carrega o vídeo
        videoElement.load();

        // Configura os controles da interface após os metadados do vídeo serem carregados
        videoElement.addEventListener("loadedmetadata", () => {
            loadingElement.style.display = "none";

            // Obtém os elementos da interface para o controle de corte e exibição de tempo
            const rangeMin = document.getElementById("rangeMin");
            const rangeMax = document.getElementById("rangeMax");

            // Adiciona os listeners de entrada para atualizar a faixa sempre que os valores mudam
            rangeMin.removeEventListener("input", updateRange);
            rangeMax.removeEventListener("input", updateRange);
            rangeMin.addEventListener("input", updateRange);
            rangeMax.addEventListener("input", updateRange);

            // Habilita os botões após o vídeo ser carregado
            document.getElementById("download-video").removeAttribute("disabled");
            document.getElementById("save-drive").removeAttribute("disabled");
            document.getElementById("cut-video").removeAttribute("disabled");

            // Atualiza a faixa de corte imediatamente
            updateRange();

            // Configura o botão de corte do vídeo
            document.getElementById("cut-video").removeEventListener("click", handleCutVideo);
            document.getElementById("cut-video").addEventListener("click", handleCutVideo);

            // Configura o botão de download do vídeo
            document.getElementById("download-video").removeEventListener("click", handleDownloadFile);
            document.getElementById("download-video").addEventListener("click", handleDownloadFile);

            // Configura o botão para salvar o vídeo no Google Drive
            document.getElementById("save-drive").removeEventListener("click", uploadToDrive);
            document.getElementById("save-drive").addEventListener("click", uploadToDrive);
        });

        // Trata erros no carregamento do vídeo
        videoElement.onerror = function () {
            console.error("Erro ao carregar o vídeo:", videoElement.error);
        };
    }
});

/**
 * Converte uma string de tempo no formato "hh:mm:ss" para segundos.
 * @param {string} time - Tempo no formato "hh:mm:ss".
 * @returns {number} Tempo em segundos.
 */
function timeToSeconds(time) {
    const [hours, minutes, seconds] = time.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Converte um tempo em segundos para o formato "hh:mm:ss".
 * @param {number} seconds - Tempo em segundos.
 * @returns {string} Tempo formatado como "hh:mm:ss".
 */
function formatTime(seconds) {
    let h = Math.floor(seconds / 3600);
    let m = Math.floor((seconds % 3600) / 60);
    let s = Math.floor(seconds % 60);
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(":");
}

/**
 * Atualiza a interface do controle de corte, ajustando a posição e largura da faixa (range)
 * e definindo os tempos de início e fim com base nos valores dos inputs.
 */
function updateRange() {
    const videoElement = document.getElementById("video");
    const startTimeInput = document.getElementById("start-time");
    const endTimeInput = document.getElementById("end-time");
    const range = document.getElementById("range");
    
    // Utiliza a duração do vídeo ou 1 para evitar divisão por zero
    const videoDuration = videoElement.duration || 1;

    // Obtém os valores mínimos e máximos dos controles deslizantes
    const minVal = parseFloat(rangeMin.value);
    const maxVal = parseFloat(rangeMax.value);

    // Calcula as porcentagens para posicionamento da faixa
    const percentMin = (minVal / rangeMin.max) * 100;
    const percentMax = (maxVal / rangeMax.max) * 100;

    // Atualiza os estilos da faixa visual que indica o corte selecionado
    range.style.left = percentMin + "%";
    range.style.width = (percentMax - percentMin) + "%";

    // Calcula os tempos correspondentes para início e fim do corte
    const startTime = (minVal / 100) * videoDuration;
    const endTime = (maxVal / 100) * videoDuration;

    // Atualiza os inputs de tempo com os valores formatados
    startTimeInput.value = formatTime(startTime);
    endTimeInput.value = formatTime(endTime);
}

// Função para cortar o video
function handleCutVideo() {
    const videoElement = document.getElementById("video");
    const startTime = document.getElementById("start-time").value;
    const endTime = document.getElementById("end-time").value;
    const loadingElement = document.querySelector(".loading");

    // Desabilita os botões para evitar múltiplos cliques enquanto o corte é processado
    document.getElementById("download-video").setAttribute("disabled", "disabled");
    document.getElementById("save-drive").setAttribute("disabled", "disabled");
    document.getElementById("cut-video").setAttribute("disabled", "disabled");

    loadingElement.style.display = "block";

    // Realiza o corte do vídeo chamando a função cutVideo, convertendo os tempos para segundos
    cutVideo("mp4", timeToSeconds(startTime), timeToSeconds(endTime)).then((videoUrl) => {
        // Atualiza a fonte do vídeo com a URL resultante do corte
        videoElement.src = videoUrl;
        // Reinicia os controles de faixa para os valores padrão
        rangeMin.value = 0;
        rangeMax.value = 100;

        // Reabilita os botões após o corte ser concluído
        document.getElementById("download-video").removeAttribute("disabled");
        document.getElementById("save-drive").removeAttribute("disabled");
        document.getElementById("cut-video").removeAttribute("disabled");

        loadingElement.style.display = "none";
    });
}

// Função para fazer upload no drive
async function uploadToDrive() {
    const videoElement = document.getElementById("video");

    // Atualiza o botão para indicar que o envio está em andamento
    document.querySelector("#save-drive").setAttribute("disabled", "disabled");
    document.querySelector("#save-drive span").innerHTML = "Enviando...";

    // Converte o blob do vídeo para um array serializável
    videoBlob.arrayBuffer().then(buffer => {
        chrome.runtime.sendMessage({
            action: "upload-file",
            format: videoElement.getAttribute("file-format"),
            file: Array.from(new Uint8Array(buffer))
        }, (response) => {
            console.log(response)

            // Atualiza a interface do botão após o upload
            document.querySelector("#save-drive").removeAttribute("disabled");
            document.querySelector("#save-drive span").innerHTML = "Enviado";

            setTimeout(() => {
                document.querySelector("#save-drive span").innerHTML = "Salvar no drive e copiar URL";
            }, 5000);
        });
    });
}

// Função de download do arquivo
async function handleDownloadFile() {
    if (downloadRequested) return;

    downloadRequested = true;

    const videoElement = document.getElementById("video");
    const link = document.createElement("a");

    // Atualiza o botão de download para indicar que o processo está em andamento
    document.querySelector("#download-video").setAttribute("disabled", "disabled");
    document.querySelector("#download-video span").innerHTML = 'Baixando...';

    link.href = videoElement.src;

    let exportType = "mp4";

    // Atualiza o atributo que indica o formato do arquivo
    videoElement.setAttribute("file-format", exportType);

    // Gera um nome único para o arquivo utilizando data e hora atuais
    const now = new Date();
    const formattedDate = now.toLocaleDateString("pt-BR").replace(/\//g, "-");
    const formattedTime = now.toTimeString().slice(0, 5).replace(":", "-");
    const fileName = `solutto-recorder-${formattedDate}_${formattedTime}.`;

    // Define o nome para o download conforme o formato escolhido
    link.download = fileName + (exportType != "mp4" ? "webm" : "mp4");

    // Simula o clique para iniciar o download e remove o link do DOM
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    downloadRequested = false;

    // Atualiza a interface do botão de download e reabilita-o após alguns segundos
    document.querySelector("#download-video").removeAttribute("disabled");
    document.querySelector("#download-video span").innerHTML = 'Baixado';
    setTimeout(() => {
        document.querySelector("#download-video span").innerHTML = "Baixar";
    }, 5000);
}