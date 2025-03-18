// Importa as classes necessárias do FFmpegWASM e FFmpegUtil
const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;

// Variáveis globais para armazenar o blob do vídeo e o nome base do arquivo
var videoBlob;
var fileName;

// Inicializa a instância do FFmpeg
const ffmpeg = new FFmpeg();

// Converte os caminhos relativos dos arquivos WASM e core para caminhos absolutos
const coreUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js");
const wasmUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm");

// Configura o listener para logs do FFmpeg e encaminha as mensagens para a função logger
ffmpeg.on("log", ({ message }) => {
    logger(message);
});

// Configura o listener para mostrar o progresso do FFmpeg
ffmpeg.on("progress", ({ progress, time }) => {
    logger((progress * 100) + "%, time: " + (time / 1000000) + " s");
});

/**
 * Adiciona uma mensagem de log na interface.
 * Cria um elemento <span> com a mensagem e o adiciona ao container de logs.
 *
 * @param {string} message - Mensagem a ser exibida.
 */
function logger(message) {
    let log = document.createElement("span");
    log.innerHTML = message;

    const editorLogs = document.querySelector(".editor-logs");
    editorLogs.appendChild(log);
    // Rola o container de logs para mostrar as mensagens mais recentes
    editorLogs.scrollTop = 9999999;
}

/**
 * Transcodifica um arquivo de vídeo para o formato especificado.
 * Se o FFmpeg não estiver carregado, ele é carregado com a quantidade de memória apropriada.
 *
 * @param {File|Blob} file - Arquivo de vídeo de entrada.
 * @param {string} format - Formato de saída desejado ("mp4" ou outro).
 * @param {number} timeout - Tempo (em segundos) a partir do qual a transcodificação deve iniciar.
 * @returns {Promise<string>} - URL do objeto Blob resultante da transcodificação.
 */
async function transcode(file, format, timeout) {
    // Carrega o FFmpeg se ainda não estiver carregado
    if (!ffmpeg.loaded) {
        const deviceMemory = navigator.deviceMemory || 4; // Utiliza 4GB como padrão se não suportado
        const totalMemoryMB = Math.min(deviceMemory * 1024, 2048);

        await ffmpeg.load({
            coreURL: coreUrl,
            wasmURL: wasmUrl,
            totalMemory: totalMemoryMB * 1024 * 1024
        });
    }

    // Gera um nome único para o arquivo com base na data e hora atual
    const now = new Date();
    const formattedDate = now.toLocaleDateString("pt-BR").replace(/\//g, "-"); // Ex: "18-03-2025"
    const formattedTime = now.toTimeString().slice(0, 5).replace(":", "-");
    fileName = `solutto-gravador-${formattedDate}_${formattedTime}`;

    // Define a lista de comandos para a transcodificação
    const commandList = [
        "-ss", timeout.toString(),
        "-i", fileName,
        "-c:v", format == "mp4" ? "libx264" : "libvpx",  // Seleciona o codec de vídeo com base no formato
        "-preset", "ultrafast",
        "-cpu-used", "8", // Acelera o processo utilizando a configuração máxima
        "-deadline", "realtime",
        "-row-mt", "1",
        "-crf", "23",
        "-b:v", "2M",       // Bitrate do vídeo; pode ser ajustado para acelerar a conversão
        "-maxrate", "2M",
        "-bufsize", "4M",
        "-threads", "0",
        "-c:a", format == "mp4" ? "aac" : "libopus", // Seleciona o codec de áudio com base no formato
        fileName + "." + format
    ];

    // Escreve o arquivo de entrada para o FFmpeg
    await ffmpeg.writeFile(fileName, await fetchFile(file));
    // Executa os comandos de transcodificação
    await ffmpeg.exec(commandList);
    // Lê o arquivo de saída gerado
    const data = await ffmpeg.readFile(fileName + "." + format);
    const blob = new Blob([data.buffer]);
    videoBlob = blob; // Atualiza a variável global com o novo blob de vídeo
    return URL.createObjectURL(blob);
}

/**
 * Corta um vídeo com base no tempo de início e na duração especificada.
 * Se o FFmpeg não estiver carregado, ele é carregado com a quantidade de memória apropriada.
 *
 * @param {string} format - Formato de saída desejado ("mp4" ou outro).
 * @param {number} startTime - Tempo inicial (em segundos) para iniciar o corte.
 * @param {number} duration - Duração (em segundos) do segmento a ser extraído.
 * @returns {Promise<string>} - URL do objeto Blob resultante do vídeo cortado.
 */
async function cutVideo(format, startTime, duration) {
    // Carrega o FFmpeg se ainda não estiver carregado
    if (!ffmpeg.loaded) {
        const deviceMemory = navigator.deviceMemory || 4;
        const totalMemoryMB = Math.min(deviceMemory * 1024, 2048);

        await ffmpeg.load({
            coreURL: coreUrl,
            wasmURL: wasmUrl,
            totalMemory: totalMemoryMB * 1024 * 1024
        });
    }

    // Define um novo nome para o arquivo cortado
    var newFileName = fileName + "_cortado." + format;
    
    // Define a lista de comandos para realizar o corte do vídeo
    const commandList = [
        "-ss", startTime.toString(),
        "-i", fileName,
        "-t", duration.toString(), // Duração do corte
        "-c:v", format == "mp4" ? "libx264" : "libvpx",  // Seleciona o codec de vídeo com base no formato
        "-preset", "ultrafast",
        "-cpu-used", "8", // Acelera o processo utilizando a configuração máxima
        "-deadline", "realtime",
        "-row-mt", "1",
        "-crf", "23",
        "-b:v", "2M",       // Bitrate do vídeo
        "-maxrate", "2M",
        "-bufsize", "4M",
        "-threads", "0",
        "-c:a", format == "mp4" ? "aac" : "libopus", // Seleciona o codec de áudio com base no formato
        newFileName
    ];

    // Escreve o blob do vídeo atual para o FFmpeg
    await ffmpeg.writeFile(fileName, await fetchFile(videoBlob));
    // Executa os comandos para cortar o vídeo
    await ffmpeg.exec(commandList);
    // Lê o arquivo de saída gerado após o corte
    const data = await ffmpeg.readFile(newFileName);
    const blob = new Blob([data.buffer]);
    videoBlob = blob; // Atualiza a variável global com o blob do vídeo cortado
    return URL.createObjectURL(blob);
}