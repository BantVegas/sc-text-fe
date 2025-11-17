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

  // feedback / stav snímky
  const [lastShotAt, setLastShotAt] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [lastPreviewUrl, setLastPreviewUrl] = useState<string | null>(null);

  // analýza – či je záber „ready“
  const [frameReady, setFrameReady] = useState(false);
  const [pendingAutoShot, setPendingAutoShot] = useState(false);

  // interný stav pre stabilitu (počítadlá medzi framami)
  const stableRef = useRef<{ frameCount: number; stableFrames: number }>({
    frameCount: 0,
    stableFrames: 0,
  });

  const shotRecently = lastShotAt !== null && Date.now() - lastShotAt < 2500; // 2.5 s „odfotené“

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

  /** Jednoduchý „focus score“ – variancia jasu (čím väčšia, tým ostrejší obraz) */
  function computeFocusScore(data: Uint8ClampedArray): number {
    let sum = 0;
    let sumSq = 0;
    const n = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += gray;
      sumSq += gray * gray;
    }

    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return variance;
  }

  /**
   * Live analýza – sledujeme ostrosť vo vnútri rámika.
   * Podmienka „READY“:
   *  - ostrosť > FOCUS_THRESHOLD
   *  - aspoň MIN_STABLE_FRAMES po sebe
   *  - po MIN_WARMUP_FRAMES (nech to nehádže zelenú hneď po štarte)
   */
  useEffect(() => {
    if (!hasPermission) return;

    let stopped = false;
    const video = videoRef.current;
    if (!video) return;

    const analysisCanvas = document.createElement("canvas");
    const ctx = analysisCanvas.getContext("2d");
    if (!ctx) return;

    const targetAR = aspectRatio > 0 ? aspectRatio : 1;

    // tieto čísla si vieš doladiť podľa reality
    const FOCUS_THRESHOLD = 1500;      // čím vyššie, tým prísnejší fokus
    const MIN_STABLE_FRAMES = 10;      // koľko framov po sebe musí byť OK
    const MIN_WARMUP_FRAMES = 15;      // koľko framov ignorujeme na začiatku

    stableRef.current.frameCount = 0;
    stableRef.current.stableFrames = 0;
    setFrameReady(false);

    const loop = () => {
      if (stopped) return;

      if (!video.videoWidth || !video.videoHeight || isFrozen || isProcessing) {
        requestAnimationFrame(loop);
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;

      const SAMPLE_W = 320;
      const SAMPLE_H = Math.round((vh / vw) * SAMPLE_W);

      analysisCanvas.width = SAMPLE_W;
      analysisCanvas.height = SAMPLE_H;

      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);

      const { sx, sy, sw, sh } = centralCrop(SAMPLE_W, SAMPLE_H, targetAR);
      const imageData = ctx.getImageData(sx, sy, sw, sh);
      const score = computeFocusScore(imageData.data);

      const state = stableRef.current;
      state.frameCount += 1;

      if (score > FOCUS_THRESHOLD) {
        state.stableFrames += 1;
      } else {
        state.stableFrames = 0;
      }

      const stableEnough =
        state.frameCount > MIN_WARMUP_FRAMES &&
        state.stableFrames >= MIN_STABLE_FRAMES;

      setFrameReady(stableEnough);

      // keď je READY, priprav auto-snímku
      if (stableEnough && !isFrozen && !isProcessing) {
        setPendingAutoShot(true);
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);

    return () => {
      stopped = true;
    };
  }, [aspectRatio, hasPermission, isFrozen, isProcessing]);

  // auto-snimek, keď analýza rozhodne, že sme READY
  useEffect(() => {
    if (pendingAutoShot && !isProcessing && !isFrozen) {
      void handleCapture();
      setPendingAutoShot(false);
    }
  }, [pendingAutoShot, isProcessing, isFrozen]);

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    setIsProcessing(true);

    try {
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

      // zamraziť náhľad + flash + text
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
    setFrameReady(false);
    setPendingAutoShot(false);
    stableRef.current.frameCount = 0;
    stableRef.current.stableFrames = 0;
  };

  const buttonLabel = (() => {
    if (isProcessing) return "Spracovávam…";
    if (isFrozen) return "Znova odfotiť";
    if (shotRecently) return "Odfotené ✓";
    return "Odfotiť manuálne";
  })();

  const buttonOnClick = isFrozen ? handleRetake : handleCapture;

  const frameBorderClass = frameReady ? "border-emerald-400/90" : "border-red-400/90";

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

        {/* rámik – tvar podľa aspectRatio, farba podľa ostrosti/stability */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className={`border-2 ${frameBorderClass} rounded-sm transition-colors duration-150`}
            style={{
              width: "70%",
              maxHeight: "70%",
              aspectRatio: `${aspectRatio > 0 ? aspectRatio : 1} / 1`,
            }}
          />
        </div>

        {/* náhľad po odfotení – prekryje video */}
        {isFrozen && lastPreviewUrl && (
          <img
            src={lastPreviewUrl}
            alt="Náhľad etikety"
            className="absolute inset-0 w-full h-full object-contain z-20 bg-black"
          />
        )}

        {/* krátky biely „flash“ pri snímke */}
        {flash && (
          <div className="absolute inset-0 bg-white/70 pointer-events-none z-30" />
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
          onClick={buttonOnClick}
          disabled={isProcessing}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white"
        >
          {buttonLabel}
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Polož etiketu na kontrastné pozadie a zarovnaj ju do rámika.
        Rám je <span className="text-red-400">červený</span>, kým nie je obraz stabilne ostrý.
        Keď zmení farbu na <span className="text-emerald-400">zelenú</span>, etiketa sa automaticky odfotí.
      </p>

      {shotRecently && (
        <p className="mt-1 text-xs text-emerald-300">
          Snímok uložený – môžeš pokračovať na porovnanie.
        </p>
      )}
    </div>
  );
}






