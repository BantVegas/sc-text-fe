// src/components/LabelCamera.tsx
import { useEffect, useRef, useState } from "react";

type LabelCameraProps = {
  title?: string;
  /** pomer strán etikety = šírka / výška (napr. 80/80 = 1, 100/50 = 2) */
  aspectRatio: number;
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

  // na vyhladenie rámika medzi snímkami
  const smoothBoxRef = useRef<BoxNorm>(null);

  /* ==============================
     Spustenie kamery + autofocus
     ============================== */
  useEffect(() => {
    let active = true;
    let stream: MediaStream | null = null;

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setErrorMsg("Tento prehliadač nepodporuje kameru.");
          return;
        }

        // základné odporúčania: zadná kamera + slušné rozlíšenie
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } as MediaTrackConstraints
        };

        stream = await navigator.mediaDevices.getUserMedia(constraints);

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

        // pokus o zapnutie continuous autofocus (ak zariadenie podporuje)
        const track = stream.getVideoTracks()[0];
        const caps = (track.getCapabilities && track.getCapabilities()) || undefined;
        if (caps && (caps as any).focusMode && Array.isArray((caps as any).focusMode)) {
          const fm = (caps as any).focusMode as string[];
          if (fm.includes("continuous")) {
            track
              .applyConstraints({ advanced: [{ focusMode: "continuous" } as any] })
              .catch(() => {});
          }
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

  /* ==========================================
     Detekcia hrán + stabilný rámik etikety
     ========================================== */
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

      // grayscale
      const gray = new Uint8ClampedArray(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = (y * W + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          gray[y * W + x] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
        }
      }

      // jednoduchý Sobel na hrany
      const EDGE_THR = 60; // čím vyššie, tým menej bordelu
      let minX = W;
      let minY = H;
      let maxX = -1;
      let maxY = -1;

      // ignoruj 8 % okraje – sú tam často rámiky, stôl, pozadie
      const borderX = Math.floor(W * 0.08);
      const borderY = Math.floor(H * 0.08);

      for (let y = borderY + 1; y < H - borderY; y++) {
        for (let x = borderX + 1; x < W - borderX; x++) {
          const idx = y * W + x;
          const gx = gray[idx + 1] - gray[idx - 1];
          const gy = gray[idx + W] - gray[idx - W];
          const mag = Math.abs(gx) + Math.abs(gy);
          if (mag > EDGE_THR) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      let newBox: BoxNorm = null;
      let good = false;

      if (maxX > minX && maxY > minY) {
        let bw = maxX - minX;
        let bh = maxY - minY;
        const area = bw * bh;
        const fullArea = W * H;
        const areaRel = area / fullArea;

        // etiketa by mala zaberať cca 20–70 % plochy → inak je to šum
        const okArea = areaRel > 0.2 && areaRel < 0.7;

        // priblíženie na požadovaný pomer strán
        const targetAR = aspectRatio || 1;
        let boxAR = bw / bh;
        if (boxAR > targetAR) {
          // príliš široké → zväčši výšku (dole/nahor) okolo stredu
          const desiredH = bw / targetAR;
          const extra = desiredH - bh;
          minY = Math.max(0, Math.round(minY - extra / 2));
          maxY = Math.min(H - 1, Math.round(maxY + extra / 2));
          bh = maxY - minY;
        } else {
          // príliš vysoké → zväčši šírku
          const desiredW = bh * targetAR;
          const extra = desiredW - bw;
          minX = Math.max(0, Math.round(minX - extra / 2));
          maxX = Math.min(W - 1, Math.round(maxX + extra / 2));
          bw = maxX - minX;
        }
        boxAR = bw / bh;

        // etiketa by mala byť zhruba v strede
        const cx = (minX + maxX) / 2 / W;
        const cy = (minY + maxY) / 2 / H;
        const dx = Math.abs(cx - 0.5);
        const dy = Math.abs(cy - 0.5);
        const centerDist = Math.sqrt(dx * dx + dy * dy);
        const okCenter = centerDist < 0.25; // max ~25 % mimo stredu

        const ratioDiff = Math.abs(boxAR - targetAR) / targetAR;
        const okRatio = ratioDiff < 0.25;

        if (okArea && okCenter && okRatio) {
          newBox = {
            x: minX / W,
            y: minY / H,
            w: bw / W,
            h: bh / H
          };
          good = true;
        }
      }

      // vyhladenie (exponenciálny priemer), aby rámik neskákal
      const prev = smoothBoxRef.current;
      let smoothed: BoxNorm = null;
      const alpha = 0.28; // 0..1; čím menšie, tým hladší pohyb

      if (newBox) {
        if (!prev) {
          smoothed = newBox;
        } else {
          smoothed = {
            x: prev.x + (newBox.x - prev.x) * alpha,
            y: prev.y + (newBox.y - prev.y) * alpha,
            w: prev.w + (newBox.w - prev.w) * alpha,
            h: prev.h + (newBox.h - prev.h) * alpha
          };
        }
      } else {
        // ak sme nič nenašli, pomaly nechaj rámik "dožiť"
        if (prev) {
          smoothed = {
            x: prev.x,
            y: prev.y,
            w: prev.w,
            h: prev.h
          };
        } else {
          smoothed = null;
        }
        good = false;
      }

      smoothBoxRef.current = smoothed;
      setBox(smoothed);
      setIsGood(!!smoothed && good);

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [aspectRatio]);

  /* ==========================
     Zachytenie a orez etikety
     ========================== */
  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    const b = smoothBoxRef.current;
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

  const colorClass = isGood ? "border-emerald-400" : "border-red-500";

  return (
    <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
      {title && <div className="text-sm font-semibold mb-2">{title}</div>}

      {/* video náhľad – mobile-first, 3:4 aby sa to podobalo telefónu na výšku */}
      <div className="relative w-full rounded-xl overflow-hidden bg-black aspect-[3/4]">
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          muted
          playsInline
        />

        {/* mierne stmavenie mimo rámika, aby oko išlo na etiketu */}
        {box && (
          <>
            <div className="absolute inset-0 pointer-events-none">
              <div
                className="absolute inset-0 bg-black/40"
                style={{
                  clipPath: `polygon(
                    0% 0%,
                    100% 0%,
                    100% 100%,
                    0% 100%,
                    0% 0%,
                    ${box.x * 100}% ${box.y * 100}%,
                    ${(box.x + box.w) * 100}% ${box.y * 100}%,
                    ${(box.x + box.w) * 100}% ${(box.y + box.h) * 100}%,
                    ${box.x * 100}% ${(box.y + box.h) * 100}%,
                    ${box.x * 100}% ${box.y * 100}%
                  )`
                }}
              />
            </div>

            {/* rámik etikety */}
            <div
              className={`absolute border-2 ${colorClass} rounded-md transition-colors duration-150`}
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`
              }}
            />
          </>
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
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white disabled:opacity-40"
          disabled={!smoothBoxRef.current}
        >
          Odfotiť
        </button>
        <canvas ref={processCanvasRef} className="hidden" />
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Zarovnaj etiketu do rámika uprostred. Keď bude rámik zelený, kamera by mala
        mať etiketu zaostrenú – potom stlač „Odfotiť“.
      </p>
    </div>
  );
}

