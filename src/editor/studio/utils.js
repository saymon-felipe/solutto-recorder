export let HEADER_WIDTH = 120;

export function updateHeaderWidth(width) {
    HEADER_WIDTH = width;
}

export function getHeaderWidth() {
    return HEADER_WIDTH;
}

export function fmtTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 10);
    return `${m}:${String(sec).padStart(2,'0')}.${ms}`;
}

export function getMediaDuration(blob) {
    return new Promise(resolve => {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => {
            if (v.duration === Infinity || isNaN(v.duration)) {
                v.currentTime = 1e101;
                v.ontimeupdate = () => { 
                    v.ontimeupdate = null; 
                    resolve(v.duration); 
                    v.src = ""; 
                };
            } else {
                resolve(v.duration);
            }
        };
        v.onerror = () => resolve(0);
        v.src = URL.createObjectURL(blob);
        
        // Fallback agressivo para WebM corrompido
        setTimeout(() => resolve(10), 2000);
    });
}