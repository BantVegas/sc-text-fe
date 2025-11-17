// src/components/LabelCamera.tsx
import { useEffect, useRef, useState } from "react";

type LabelCameraProps = {
  title?: string;
  /** šírka / výška, napr. 80/80 = 1, 100/50 = 2 */
  aspectRatio: number;
  onCapture: (file: File, previewUrl: string) => void;
};

export default function LabelCamera({ title, aspectRatio, onCapture }: LabelCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const [lastShotAt, setLastShotAt] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [lastPreviewUrl, setLastPreviewUrl] = useState<string | null>(null);

  const shotRecently = lastShotAt !== null && Date.now() - lastShotAt < 2500;

  // kamera
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
          audio: false,
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

  /** Centrálne orezanie podľa cieľového pomeru strán */
  function centralCrop(
    W: number,
    H: number,
    targetAR: number
  ): { sx: number; sy: number; sw: number; sh: number } {
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
    if (!video.videoWidth || !video.videoHeight) return;

    setIsProcessing(true);
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;

      const CAP_W = 1280;
      const CAP_H = Math.round((vh / vw) * CAP_W);

      const canvas = document.createElement("canvas");
      canvas.width = CAP_W;
      canvas.height = CAP_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, CAP_W, CAP_H);

      const targetAR = aspectRatio > 0 ? aspectRatio : 1;
      const { sx, sy, sw, sh } = centralCrop(CAP_W, CAP_H, targetAR);

      const outW = 1000;
      const outH = Math.round(outW / targetAR);
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

      setLastPreviewUrl(previewUrl);
      setIsFrozen(true);
      setLastShotAt(Date.now());
      setFlash(true);
      setTimeout(() => setFlash(false), 120);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetake = () => {
    setIsFrozen(false);
    setLastPreviewUrl(null);
    setLastShotAt(null);
  };

  const buttonLabel = (() => {
    if (isProcessing) return "Spracovávam…";
    if (isFrozen) return "Znova odfotiť";
    if (shotRecently) return "Odfotené ✓";
    return "Odfotiť";
  })();

  const buttonOnClick = isFrozen ? handleRetake : handleCapture;

  return (
    <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
      {title && <div className="text-sm font-semibold mb-2">{title}</div>}

      <div className="relative w-full rounded-xl overflow-hidden bg-black aspect-[3/4]">
        {/* živé video */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          muted
          playsInline
        />

        {/* rámik – tvar podľa aspectRatio, vždy červený */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="border-2 border-red-400/90 rounded-sm"
            style={{
              width: "70%",
              maxHeight: "70%",
              aspectRatio: `${aspectRatio > 0 ? aspectRatio : 1} / 1`,
            }}
          />
        </div>

        {/* náhľad po odfotení */}
        {isFrozen && lastPreviewUrl && (
          <img
            src={lastPreviewUrl}
            alt="Náhľad etikety"
            className="absolute inset-0 w-full h-full object-contain z-20 bg-black"
          />
        )}

        {/* flash */}
        {flash && (
          <div className="absolute inset-0 bg-white/70 pointer-events-none z-30" />
        )}
      </div>

      {!hasPermission && !errorMsg && (
        <p className="mt-2 text-xs text-slate-400">Čakám na povolenie kamery…</p>
      )}
      {errorMsg && (
        <p className="mt-2 text-xs text-red-400">{errorMsg}</p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={buttonOnClick}
          disabled={isProcessing}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white"
        >
          {buttonLabel}
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Zarovnaj etiketu do červeného rámika a keď je obraz ostrý, stlač „Odfotiť“.
        My urobíme orez podľa rámika a pošleme snímok na porovnanie.
      </p>

      {shotRecently && (
        <p className="mt-1 text-xs text-emerald-300">
          Snímok uložený – môžeš pokračovať na porovnanie.
        </p>
      )}
    </div>
  );
}








