const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;
var videoBlob;
var fileName;

// initialize ffmpeg
const ffmpeg = new FFmpeg();

// convert wasm and core url to absolute path
const coreUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js");
const wasmUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm");

// log ffmpeg messages
ffmpeg.on("log", ({ message }) => {
    logger(message);
});

// progress bar
ffmpeg.on("progress", ({ progress, time }) => {
    logger((progress * 100) + "%, time: " + (time / 1000000) + " s");
});

function logger(message) {
    let log = document.createElement("span");
    log.innerHTML = message;

    document.querySelector(".editor-logs").appendChild(log);
    document.querySelector(".editor-logs").scrollTop = 9999999;
}

async function transcode(file, format, timeout) {

    if (!ffmpeg.loaded) {
        const deviceMemory = navigator.deviceMemory || 4; // Padrão para 4GB se não suportado
        const totalMemoryMB = Math.min(deviceMemory * 1024, 2048);

        await ffmpeg.load({
            coreURL: coreUrl,
            wasmURL: wasmUrl,
            totalMemory: totalMemoryMB * 1024 * 1024
        });
    }

    const now = new Date();
    const formattedDate = now.toLocaleDateString("pt-BR").replace(/\//g, "-"); // "18-03-2025"
    const formattedTime = now.toTimeString().slice(0, 5).replace(":", "-");
    
    fileName = `solutto-gravador-${formattedDate}_${formattedTime}`;

    const commandList = [
        "-ss", timeout.toString(),
        "-i", fileName,
        "-c:v", format == "mp4" ? "libx264" : "libvpx",  // VP8 para WebM //libvpx (webm) //libvpx-vp9 (webm) //libx264
        "-preset", "ultrafast",
        "-cpu-used", "8", // Máximo para acelerar
        "-deadline", "realtime",
        "-row-mt", "1",
        "-crf", "23",
        "-b:v", "2M",       // Aumentar bitrate pode acelerar a conversão //2M (bitrate maior) //500k (bitrate menor)
        "-maxrate", "2M",
        "-bufsize", "4M",
        "-threads", "0",
        "-c:a", format == "mp4" ? "aac" : "libopus", // Áudio compatível com WebM //libopus (webm) //aac
        fileName + "." + format
    ];

    await ffmpeg.writeFile(fileName, await fetchFile(file));
    await ffmpeg.exec(commandList);
    const data = await ffmpeg.readFile(fileName + "." + format);
    const blob = new Blob([data.buffer]);
    videoBlob = blob;
    return URL.createObjectURL(blob);
}

async function cutVideo(format, startTime, duration) {
    if (!ffmpeg.loaded) {
        const deviceMemory = navigator.deviceMemory || 4;
        const totalMemoryMB = Math.min(deviceMemory * 1024, 2048);

        await ffmpeg.load({
            coreURL: coreUrl,
            wasmURL: wasmUrl,
            totalMemory: totalMemoryMB * 1024 * 1024
        });
    }

    var newFileName = fileName + "_cortado." + format;
    
    const commandList = [
        "-ss", startTime.toString(),
        "-i", fileName,
        "-t", duration.toString(), // Duração do corte
        "-c:v", format == "mp4" ? "libx264" : "libvpx",  // VP8 para WebM //libvpx (webm) //libvpx-vp9 (webm) //libx264
        "-preset", "ultrafast",
        "-cpu-used", "8", // Máximo para acelerar
        "-deadline", "realtime",
        "-row-mt", "1",
        "-crf", "23",
        "-b:v", "2M",       // Aumentar bitrate pode acelerar a conversão //2M (bitrate maior) //500k (bitrate menor)
        "-maxrate", "2M",
        "-bufsize", "4M",
        "-threads", "0",
        "-c:a", format == "mp4" ? "aac" : "libopus", // Áudio compatível com WebM //libopus (webm) //aac
        newFileName
    ];

    await ffmpeg.writeFile(fileName, await fetchFile(videoBlob));
    await ffmpeg.exec(commandList);
    const data = await ffmpeg.readFile(newFileName);
    const blob = new Blob([data.buffer]);
    videoBlob = blob;
    return URL.createObjectURL(blob);
}