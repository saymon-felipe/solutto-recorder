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

    if (ffmpeg.loaded) {
        await ffmpeg.terminate();
    }

    // load ffmpeg
    await ffmpeg.load({
        coreURL: coreUrl,
        wasmURL: wasmUrl,
        totalMemory: 512 * 1024 * 1024
    });

    const name = 'screen-recording';

    const commandList = [
        "-ss", timeout,
        "-i", name,
        "-vf", "scale=1280:-1",
        "-c:v", "libvpx",  // VP8 para WebM
        "-preset", "ultrafast",
        "-cpu-used", "4", // Máximo para acelerar
        "-deadline", "realtime",
        "-crf", "23",
        "-b:v", "1M",
        "-c:a", "libopus", // Áudio compatível com WebM
        name + "." + format
    ];

    console.log("ffmpeg carregado, preparando pra converter")
    await ffmpeg.writeFile(name, await fetchFile(file));
    await ffmpeg.exec(commandList);
    const data = await ffmpeg.readFile(name + "." + format);
    console.log("video convertido", data)
    const blob = new Blob([data.buffer]);
    console.log(blob)
    return URL.createObjectURL(blob);
  }