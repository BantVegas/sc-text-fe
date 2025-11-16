// src/components/LabelCamera.tsx
import { useEffect, useRef, useState } from "react";

type LabelCameraProps = {
  title?: string;
  aspectRatio: number; // šírka / výška (napr. 80/80 = 1, 100/50 = 2)
  onCapture: (file: File, previewUrl: string) => void;
};

export default function LabelCamera({ title, aspectRatio, onCapture }: LabelCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // feedback po odfotení
  const [lastShotAt, setLastShotAt] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);

  const shotRecently =
    lastShotAt !== null && Date.now() - lastShotAt < 2000; // 2 sekundy „odfotené“

  // spustenie kamery
  useEffect(() => {
    let active = true;
    let stream: MediaStream | null = null;

    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setErrorMsg("Tento prehliadač nepodporuje kameru.");
          return;
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" }
        });

        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
          setHasPermission(true);
        }
      } catch (e) {
        console.error(e);
        setErrorMsg("Nepodarilo sa spustiť kameru (povolenia / zariadenie).");
      }
    })();

    return () => {
      active = false;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  /** Auto-crop na etiketu uprostred (svetlejší objekt na tmavšom pozadí) */
  function autoCrop(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    targetAR: number
  ): { sx: number; sy: number; sw: number; sh: number } {
    const W = canvas.width;
    const H = canvas.height;

    const imgData = ctx.getImageData(0, 0, W, H);
    const data = imgData.data;

    const gray = new Uint8Array(W * H);
    let minG = 255;
    let maxG = 0;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const gY = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        gray[y * W + x] = gY;
        if (gY < minG) minG = gY;
        if (gY > maxG) maxG = gY;
      }
    }

    // prah medzi pozadím a etiketou
    const thr = minG + (maxG - minG) * 0.6; // etiketa je svetlejšia

    // hľadáme svetlý „blob“ v centrálnej oblasti
    const marginX = Math.round(W * 0.1);
    const marginY = Math.round(H * 0.1);

    let minX = W,
      minY = H,
      maxX = -1,
      maxY = -1;

    for (let y = marginY; y < H - marginY; y++) {
      for (let x = marginX; x < W - marginX; x++) {
        const gY = gray[y * W + x];
        if (gY > thr) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // keď nič nenašlo, fallback – stredový rectangle podľa aspectRatio
    if (maxX <= minX || maxY <= minY) {
      return centralCrop(W, H, targetAR);
    }

    let bw = maxX - minX + 1;
    let bh = maxY - minY + 1;
    const area = bw * bh;
    const fullArea = W * H;

    // ak je objekt príliš malý alebo takmer cez celý obraz, fallback
    if (area < fullArea * 0.05 || area > fullArea * 0.95) {
      return centralCrop(W, H, targetAR);
    }

    // upraviť bounding box na požadovaný pomer strán (rozšírením / zúžením)
    const currentAR = bw / bh;
    let sx = minX;
    let sy = minY;

    if (currentAR > targetAR) {
      // príliš široké → zväčšiť výšku
      const newBh = bw / targetAR;
      const diff = newBh - bh;
      sy = Math.max(0, sy - diff / 2);
      bh = Math.min(H - sy, newBh);
    } else {
      // príliš vysoké → zväčšiť šírku
      const newBw = bh * targetAR;
      const diff = newBw - bw;
      sx = Math.max(0, sx - diff / 2);
      bw = Math.min(W - sx, newBw);
    }

    // padding, ale v rámci obrazu
    const padX = bw * 0.05;
    const padY = bh * 0.05;
    sx = Math.max(0, sx - padX);
    sy = Math.max(0, sy - padY);
    bw = Math.min(W - sx, bw + 2 * padX);
    bh = Math.min(H - sy, bh + 2 * padY);

    return { sx, sy, sw: bw, sh: bh };
  }

  function centralCrop(
    W: number,
    H: number,
    targetAR: number
  ): { sx: number; sy: number; sw: number; sh: number } {
    // vyrež stred tak, aby mal požadovaný pomer strán
    let sw = W * 0.7;
    let sh = sw / targetAR;

    if (sh > H * 0.7) {
      sh = H * 0.7;
      sw = sh * targetAR;
    }

    const sx = (W - sw) / 2;
    const sy = (H - sh) / 2;
    return { sx, sy, sw, sh };
  }

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    setIsProcessing(true);

    try {
      // normalizačný canvas
      const CAP_W = 1280;
      const CAP_H = Math.round((vh / vw) * CAP_W);

      const canvas = document.createElement("canvas");
      canvas.width = CAP_W;
      canvas.height = CAP_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, CAP_W, CAP_H);

      const targetAR = aspectRatio > 0 ? aspectRatio : 1;
      const { sx, sy, sw, sh } = autoCrop(canvas, ctx, targetAR);

      // výstupný canvas – normalizovaná etiketa
      let outW = 1000;
      let outH = Math.round(outW / targetAR);
      const outCanvas = document.createElement("canvas");
      outCanvas.width = outW;
      outCanvas.height = outH;
      const octx = outCanvas.getContext("2d");
      if (!octx) return;

      octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, outW, outH);

      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob((b2) => resolve(b2), "image/jpeg", 0.92)
      );
      if (!blob) return;

      const file = new File([blob], "label.jpg", { type: "image/jpeg" });
      const previewUrl = outCanvas.toDataURL("image/jpeg", 0.8);

      onCapture(file, previewUrl);

      // vizuálny feedback
      setLastShotAt(Date.now());
      setFlash(true);
      setTimeout(() => setFlash(false), 120); // krátky „biely záblesk“
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
      {title && <div className="text-sm font-semibold mb-2">{title}</div>}

      <div className="relative w-full rounded-xl overflow-hidden bg-black aspect-[3/4]">
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          muted
          playsInline
        />

        {/* statický „skener“ rámik s pomerom strán etikety */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="border-2 border-emerald-400/70 rounded-sm"
            style={{
              width: "70%",
              height: `${70 / (aspectRatio || 1)}%`,
              maxHeight: "70%"
            }}
          />
        </div>

        {/* krátky biely „flash“ pri snímke */}
        {flash && (
          <div className="absolute inset-0 bg-white/70 pointer-events-none" />
        )}
      </div>

      {!hasPermission && !errorMsg && (
        <p className="mt-2 text-xs text-slate-400">
          Čakám na povolenie kamery…
        </p>
      )}
      {errorMsg && (
        <p className="mt-2 text-xs text-red-400">
          {errorMsg}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleCapture}
          disabled={isProcessing}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white"
        >
          {isProcessing
            ? "Spracovávam…"
            : shotRecently
            ? "Odfotené ✓"
            : "Odfotiť"}
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Polož etiketu na kontrastné pozadie, zarovnaj ju do rámika a stlač „Odfotiť“.
      </p>

      {shotRecently && (
        <p className="mt-1 text-xs text-emerald-300">
          Snímok uložený – môžeš pokračovať na porovnanie.
        </p>
      )}
    </div>
  );
}


