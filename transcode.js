const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;

// initialize ffmpeg
const ffmpeg = new FFmpeg();

// convert wasm and core url to absolute path
const coreUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js");
const wasmUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm");

// log ffmpeg messages
ffmpeg.on("log", ({ message }) => {
    console.log(message);
});

// progress bar
ffmpeg.on("progress", ({ progress, time }) => {
    console.log((progress * 100) + "%, time: " + (time / 1000000) + " s");
});

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

    const name = 'screen-recording';

    const commandList = [
        "-ss", timeout,
        "-i", name,
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
        name + "." + format
    ];

    console.log("ffmpeg carregado, preparando pra converter")
    await ffmpeg.writeFile(name, await fetchFile(file));
    await ffmpeg.exec(commandList);
    const data = await ffmpeg.readFile(name + "." + format);
    console.log("video convertido", data)
    const blob = new Blob([data.buffer]);
    return URL.createObjectURL(blob);
  }