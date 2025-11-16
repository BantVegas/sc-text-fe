// src/components/LabelCamera.tsx
import { useEffect, useRef, useState } from "react";

type LabelCameraProps = {
  title?: string;
  aspectRatio: number; // šírka / výška v mm (napr. 80/80 = 1)
  onCapture: (file: File, previewUrl: string) => void;
};

type BoxNorm = { x: number; y: number; w: number; h: number } | null;

export default function LabelCamera({ title, aspectRatio, onCapture }: LabelCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const processCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [box, setBox] = useState<BoxNorm>(null);
  const [isGood, setIsGood] = useState(false);

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
          video: { facingMode: "environment" },
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

  // detekcia obdĺžnika etikety pomocou projekčných histogramov hrán
  useEffect(() => {
    const canvas = processCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 320;
    const H = 240;
    canvas.width = W;
    canvas.height = H;

    let rafId: number;

    const tick = () => {
      if (!video || video.readyState < 2) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      ctx.drawImage(video, 0, 0, W, H);
      const imgData = ctx.getImageData(0, 0, W, H);
      const data = imgData.data;

      const gray = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          gray[y * W + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        }
      }

      const colSum = new Uint16Array(W);
      const rowSum = new Uint16Array(H);

      const EDGE_THR = 35;
      const marginX = Math.round(W * 0.05);
      const marginY = Math.round(H * 0.05);

      for (let y = marginY + 1; y < H - marginY; y++) {
        for (let x = marginX + 1; x < W - marginX; x++) {
          const idx = y * W + x;
          const g0 = gray[idx];
          const gx = Math.abs(g0 - gray[idx - 1]);
          const gy = Math.abs(g0 - gray[idx - W]);
          if (gx + gy > EDGE_THR) {
            colSum[x]++;
            rowSum[y]++;
          }
        }
      }

      let maxCol = 0;
      let maxRow = 0;
      for (let x = 0; x < W; x++) if (colSum[x] > maxCol) maxCol = colSum[x];
      for (let y = 0; y < H; y++) if (rowSum[y] > maxRow) maxRow = rowSum[y];

      if (maxCol === 0 || maxRow === 0) {
        setBox(null);
        setIsGood(false);
        rafId = requestAnimationFrame(tick);
        return;
      }

      const colThr = maxCol * 0.4;
      const rowThr = maxRow * 0.4;

      let minX = W;
      let maxX = -1;
      for (let x = marginX; x < W - marginX; x++) {
        if (colSum[x] > colThr) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }

      let minY = H;
      let maxY = -1;
      for (let y = marginY; y < H - marginY; y++) {
        if (rowSum[y] > rowThr) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      if (maxX > minX && maxY > minY) {
        // malý padding dovnútra
        const pad = 2;
        minX = Math.max(marginX, minX - pad);
        maxX = Math.min(W - marginX, maxX + pad);
        minY = Math.max(marginY, minY - pad);
        maxY = Math.min(H - marginY, maxY + pad);

        const bw = maxX - minX;
        const bh = maxY - minY;
        const area = bw * bh;
        const fullArea = W * H;
        const areaRel = area / fullArea;
        const boxRatio = bw / bh;
        const targetAR = aspectRatio || 1;
        const ratioDiff = Math.abs(boxRatio - targetAR) / targetAR;

        const okArea = areaRel > 0.1 && areaRel < 0.8;
        const okRatio = ratioDiff < 0.25; // ± ~25 %

        setBox({
          x: minX / W,
          y: minY / H,
          w: bw / W,
          h: bh / H,
        });
        setIsGood(okArea && okRatio);
      } else {
        setBox(null);
        setIsGood(false);
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [aspectRatio]);

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const b = box;
    if (!b) return;

    const sx = b.x * vw;
    const sy = b.y * vh;
    const sw = b.w * vw;
    const sh = b.h * vh;

    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.max(1, Math.round(sw));
    outCanvas.height = Math.max(1, Math.round(sh));
    const octx = outCanvas.getContext("2d");
    if (!octx) return;

    octx.drawImage(
      video,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      outCanvas.width,
      outCanvas.height
    );

    const blob = await new Promise<Blob | null>((resolve) =>
      outCanvas.toBlob((b2) => resolve(b2), "image/jpeg", 0.92)
    );
    if (!blob) return;

    const file = new File([blob], "label.jpg", { type: "image/jpeg" });
    const previewUrl = outCanvas.toDataURL("image/jpeg", 0.8);

    onCapture(file, previewUrl);
  };

  const colorClass = isGood ? "border-emerald-400" : "border-red-400";

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
        {box && (
          <div
            className={`absolute border-2 ${colorClass} transition-colors`}
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
            }}
          />
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
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white"
        >
          Odfotiť
        </button>
        <canvas ref={processCanvasRef} className="hidden" />
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Zarovnaj etiketu do rámika. Keď bude rámik zelený, stlač „Odfotiť“.
      </p>
    </div>
  );
}
