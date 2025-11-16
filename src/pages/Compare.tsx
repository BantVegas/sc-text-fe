import { useMemo, useRef, useState, useEffect } from "react";

// ===== ENV =====
const JAVA_BASE = import.meta.env.VITE_JAVA_BASE_URL || "http://localhost:8080";
const PY_BASE   = import.meta.env.VITE_PY_BASE_URL   || "http://localhost:8011";

// ===== helpers =====
const fileToDataURL = (f: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** Auto-crop etikety na bielom papieri – nájde ne-biele pixely a spraví bounding box. */
function detectLabelBounds(img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
  const w = img.width;
  const h = img.height;
  if (!w || !h) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  let minX = w, minY = h, maxX = -1, maxY = -1;
  const WHITE_THR = 245;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      if (a > 0 && (r < WHITE_THR || g < WHITE_THR || b < WHITE_THR)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  const area = boxW * boxH;
  const fullArea = w * h;
  if (area < fullArea * 0.01) return null;

  return { x: minX, y: minY, w: boxW, h: boxH };
}

/** Export orezanej oblasti do File (JPEG, downscale + kompresia). */
async function exportCroppedRegion(
  img: HTMLImageElement,
  region: { x: number; y: number; w: number; h: number },
  filename: string,
  opts: { maxSide?: number; maxBytes?: number } = {}
): Promise<File> {
  const maxSide  = opts.maxSide  ?? 4000;
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;

  const { x, y, w, h } = region;
  const scale = Math.max(w, h) > maxSide ? maxSide / Math.max(w, h) : 1;
  const w0 = Math.max(1, Math.round(w * scale));
  const h0 = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w0;
  canvas.height = h0;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context error");

  ctx.drawImage(img, x, y, w, h, 0, 0, w0, h0);

  let q = 0.92;
  let blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
  if (!blob) throw new Error("toBlob failed");
  while (blob.size > maxBytes && q > 0.6) {
    q -= 0.08;
    blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", q));
    if (!blob) break;
  }
  if (!blob) throw new Error("toBlob failed");

  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  return new File([blob], `${base}-crop.jpg`, { type: "image/jpeg" });
}

/** Spracovanie fotky z fotoaparátu – auto-crop etikety na bielom podklade. */
async function processCameraImage(
  file: File,
  opts: { maxSide?: number; maxBytes?: number } = {}
): Promise<File> {
  const src = await fileToDataURL(file);
  const img = await loadImage(src);
  const bounds = detectLabelBounds(img) ?? { x: 0, y: 0, w: img.width, h: img.height };
  return exportCroppedRegion(img, bounds, file.name, opts);
}

const toImgUrl = (maybeDataUrlOrB64: string): string => {
  if (!maybeDataUrlOrB64) return "";
  if (maybeDataUrlOrB64.startsWith("data:")) return maybeDataUrlOrB64;
  return `data:image/jpeg;base64,${maybeDataUrlOrB64}`;
};

async function fetchJSON(url: string, fd: FormData) {
  const r = await fetch(url, { method: "POST", body: fd });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return await r.json();
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

// ===== types =====
type Box = { x:number; y:number; w:number; h:number; type?: "ocr" | "barcode" | "diff"; subType?: string|null; desc?: string; };
type OcrDiff = { line:number; master:string; scan:string };
type BcItem = { side?: "master" | "scan"; symbology:string; value:string; valid:boolean; reason?:string|null };

type LabelView = {
  url:string; w:number; h:number; boxes:Box[];
  ocrMaster?:string; ocrScan?:string; ocrDiffs?: OcrDiff[];
  barcode?: BcItem[]; barcodeMatch?: boolean;
};

type CropRect = { x:number; y:number; w:number; h:number };
type CropMode = null | "master" | "etiketa";

// riadkový diff, ak BE nedodá
function makeLineDiffs(master = "", scan = ""): OcrDiff[] {
  const A = master.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const B = scan.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const L = Math.max(A.length, B.length);
  const diffs: OcrDiff[] = [];
  for (let i=0;i<L;i++){
    const a = A[i] ?? "";
    const b = B[i] ?? "";
    if (a !== b) diffs.push({ line: i+1, master: a, scan: b });
  }
  return diffs;
}

// deduplikácia kódov (strana+symbology+value)
function dedupeBc(items: BcItem[]): BcItem[] {
  const map = new Map<string, BcItem>();
  for (const b of items || []) {
    const key = `${b.side||""}|${(b.symbology||"").toUpperCase()}|${String(b.value||"").trim()}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        ...b,
        symbology: (b.symbology||"").toUpperCase(),
        value: String(b.value||"").trim()
      });
    } else {
      cur.valid = cur.valid && b.valid;
      if (!cur.reason && b.reason) cur.reason = b.reason;
    }
  }
  return [...map.values()];
}

function iou(
  a: { x:number; y:number; w:number; h:number },
  b: { x:number; y:number; w:number; h:number }
) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

function dedupeBoxes<T extends {x:number;y:number;w:number;h:number;type?:string;subType?:string|null}>(arr: T[], thr = 0.9) {
  const out: T[] = [];
  for (const b of arr) {
    const dup = out.find(o => iou(o, b) >= thr && (o.type || "") === (b.type || ""));
    if (!dup) out.push(b);
  }
  return out;
}

export default function Compare() {
  // files & previews
  const [masterFile, setMasterFile]   = useState<File | null>(null);
  const [masterUrl, setMasterUrl]     = useState<string>("");
  const [etiketaFile, setEtiketaFile] = useState<File | null>(null);
  const [etiketaUrl, setEtiketaUrl]   = useState<string>("");

  const [isComparing, setIsComparing] = useState(false);
  const [view, setView]               = useState<LabelView|null>(null);

  // report meta
  const [operatorName, setOperatorName]   = useState(localStorage.getItem("etis_operator") || "");
  const [orderNumber, setOrderNumber]     = useState(localStorage.getItem("etis_order") || "");
  const [productNumber, setProductNumber] = useState(localStorage.getItem("etis_product") || "");
  const [generatedAt, setGeneratedAt]     = useState<Date | null>(null);

  useEffect(() => { localStorage.setItem("etis_operator", operatorName) }, [operatorName]);
  useEffect(() => { localStorage.setItem("etis_order", orderNumber) }, [orderNumber]);
  useEffect(() => { localStorage.setItem("etis_product", productNumber) }, [productNumber]);

  // refs na file inputy (galéria + fotoaparát)
  const masterFileInputRef    = useRef<HTMLInputElement | null>(null);
  const masterCameraInputRef  = useRef<HTMLInputElement | null>(null);
  const etiketaFileInputRef   = useRef<HTMLInputElement | null>(null);
  const etiketaCameraInputRef = useRef<HTMLInputElement | null>(null);

  // === CROP modal state (ručný crop pre galériu) ===
  const [cropMode, setCropMode]       = useState<CropMode>(null);
  const [cropSrc, setCropSrc]         = useState<string>("");
  const [cropFileName, setCropFileName] = useState<string>("label.jpg");
  const [cropRect, setCropRect]       = useState<CropRect | null>(null);
  const [cropSize, setCropSize]       = useState<{w:number;h:number}>({w:0,h:0});
  const cropOverlayRef                = useRef<HTMLDivElement | null>(null);
  const cropStartRef                  = useRef<{x:number;y:number} | null>(null);

  // ====== HANDLERY – GALÉRIA => ručný crop ======
  const onMasterFromGallery = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f0 = e.target.files?.[0];
    if (!f0) return;
    const url = await fileToDataURL(f0);
    setCropMode("master");
    setCropSrc(url);
    setCropFileName(f0.name);
    setCropRect(null);
  };

  const onEtiketaFromGallery = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f0 = e.target.files?.[0];
    if (!f0) return;
    const url = await fileToDataURL(f0);
    setCropMode("etiketa");
    setCropSrc(url);
    setCropFileName(f0.name);
    setCropRect(null);
  };

  // ====== HANDLERY – FOTOAPARÁT => auto-crop ======
  const onMasterFromCamera = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f0 = e.target.files?.[0];
    if (!f0) return;
    const f = await processCameraImage(f0);
    setMasterFile(f);
    setMasterUrl(await fileToDataURL(f));
  };

  const onEtiketaFromCamera = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f0 = e.target.files?.[0];
    if (!f0) return;
    const f = await processCameraImage(f0);
    setEtiketaFile(f);
    setEtiketaUrl(await fileToDataURL(f));
  };

  // ====== CROP INTERAKCIA (myš/prst) ======
  function getPointFromEvent(e: React.MouseEvent | React.TouchEvent): {x:number;y:number} | null {
    const rect = cropOverlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    let clientX: number;
    let clientY: number;
    if ("touches" in e && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if ("changedTouches" in e && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else if ("clientX" in e) {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    } else {
      return null;
    }
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const ix = Math.max(0, Math.min(rect.width, x));
    const iy = Math.max(0, Math.min(rect.height, y));
    return { x: ix, y: iy };
  }

  function handleCropStart(e: React.MouseEvent | React.TouchEvent) {
    const p = getPointFromEvent(e);
    if (!p) return;
    cropStartRef.current = p;
    setCropRect({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function handleCropMove(e: React.MouseEvent | React.TouchEvent) {
    if (!cropStartRef.current) return;
    e.preventDefault();
    const p = getPointFromEvent(e);
    if (!p) return;
    const sx = cropStartRef.current.x;
    const sy = cropStartRef.current.y;
    const x = Math.min(sx, p.x);
    const y = Math.min(sy, p.y);
    const w = Math.abs(p.x - sx);
    const h = Math.abs(p.y - sy);
    setCropRect({ x, y, w, h });
  }

  function handleCropEnd() {
    cropStartRef.current = null;
  }

  async function applyCrop() {
    if (!cropMode || !cropRect || !cropSrc || !cropSize.w || !cropSize.h) {
      setCropMode(null);
      return;
    }
    try {
      const img = await loadImage(cropSrc);
      const scaleX = img.width  / cropSize.w;
      const scaleY = img.height / cropSize.h;
      const region = {
        x: cropRect.x * scaleX,
        y: cropRect.y * scaleY,
        w: cropRect.w * scaleX,
        h: cropRect.h * scaleY,
      };
      const file = await exportCroppedRegion(img, region, cropFileName);
      const url  = await fileToDataURL(file);

      if (cropMode === "master") {
        setMasterFile(file);
        setMasterUrl(url);
      } else {
        setEtiketaFile(file);
        setEtiketaUrl(url);
      }
    } catch (err) {
      alert("Chyba pri orezaní obrázka.");
      console.error(err);
    } finally {
      setCropMode(null);
      setCropSrc("");
      setCropRect(null);
    }
  }

  function cancelCrop() {
    setCropMode(null);
    setCropSrc("");
    setCropRect(null);
  }

  // ==== main compare ====
  async function doCompare() {
    if (!masterFile || !etiketaFile) { alert("Najprv nahraj master aj etiketu."); return; }
    setIsComparing(true);
    try {
      const fd = new FormData();
      fd.append("master", masterFile);
      fd.append("etiketa", etiketaFile);
      fd.append("operator", operatorName);
      fd.append("productNumber", productNumber);
      fd.append("orderNumber", orderNumber);
      fd.append("spoolNumber", orderNumber); // kompatibilita s BE

      // 1) Java
      let resp: any = await fetchJSON(`${JAVA_BASE}/api/compare-one`, fd).catch(() => null);
      if (!resp) {
        // 2) Python
        resp = await fetchJSON(`${PY_BASE}/api/compare-one`, fd).catch(() => null);
      }
      if (!resp) {
        // 3) fallback starý /api/compare
        const img = await loadImage(masterUrl);
        const fd2 = new FormData();
        fd2.append("master", masterFile);
        fd2.append("scan",   etiketaFile);
        fd2.append("rows", "1"); fd2.append("cols", "1");
        fd2.append("label_w", String(img.width));
        fd2.append("label_h", String(img.height));
        fd2.append("gap_x", "0"); fd2.append("gap_y", "0");
        fd2.append("dpi", "800"); fd2.append("wind", "A1");
        resp = await fetchJSON(`${PY_BASE}/api/compare`, fd2);
      }

      let label: LabelView | null = null;

      if (resp && (resp.ocr || resp.barcode || resp.barcodes || resp.graphics)) {
        const url = toImgUrl(resp.image || etiketaUrl);
        const w = Number(resp.w || resp.width) || 0;
        const h = Number(resp.h || resp.height) || 0;

        const boxes: Box[] = dedupeBoxes([
          ...(Array.isArray(resp.graphics?.boxes) ? resp.graphics.boxes : []).map((b:any)=>({
            x:+(b.x||b[0]||0), y:+(b.y||b[1]||0), w:+(b.w||b[2]||1), h:+(b.h||b[3]||1),
            type:"diff", subType:b.subType||null, desc:b.desc||"Rozdiel"
          }))
        ]);

        const ocrMaster = resp.ocr?.masterText || "";
        const ocrScan   = resp.ocr?.scanText   || "";
        const ocrDiffs: OcrDiff[] = Array.isArray(resp.ocr?.diffs) ? resp.ocr.diffs : makeLineDiffs(ocrMaster, ocrScan);

        // barcode
        let bcItems: BcItem[] = [];
        let bcMatch: boolean | undefined = undefined;

        if (resp.barcode && Array.isArray(resp.barcode.items)) {
          bcItems = resp.barcode.items.map((b:any)=>({
            symbology: b.symbology || b.type || "-",
            value: b.value || b.text || "-",
            valid: !!b.valid,
            reason: b.reason || null
          }));
          if (typeof resp.barcode.match === "boolean") bcMatch = resp.barcode.match;
        }
        if (resp.barcodes) {
          const mArr = Array.isArray(resp.barcodes.master) ? resp.barcodes.master : [];
          const sArr = Array.isArray(resp.barcodes.scan)   ? resp.barcodes.scan   : [];
          bcItems = [
            ...mArr.map((b:any)=>({ side:"master" as const, symbology:b.type||b.symbology||"-", value:b.data||b.value||"-", valid: !!(b.valid ?? true), reason:b.reason||null })),
            ...sArr.map((b:any)=>({ side:"scan"   as const, symbology:b.type||b.symbology||"-", value:b.data||b.value||"-", valid: !!(b.valid ?? true), reason:b.reason||null })),
          ];
          if (typeof resp.barcodes.match === "boolean") bcMatch = resp.barcodes.match;
          if (bcMatch === undefined && mArr.length && sArr.length) {
            const mSet = new Set(mArr.map((b:any)=>String(b.data||b.value||"")));
            bcMatch = sArr.some((b:any)=>mSet.has(String(b.data||b.value||"")));
          }
        }

        label = {
          url, w, h, boxes,
          ocrMaster, ocrScan, ocrDiffs,
          barcode: dedupeBc(bcItems),
          barcodeMatch: bcMatch
        };
      }

      if (!label) {
        console.warn("Neznámy formát odpovede:", resp);
        alert("Porovnanie nevrátilo použiteľný výsledok.");
        setView(null);
        return;
      }

      setView(label);
      setGeneratedAt(new Date());
    } catch (e:any) {
      alert("Chyba porovnania: " + (e?.message || String(e)));
      setView(null);
    } finally {
      setIsComparing(false);
    }
  }

  // ===== overlay canvas =====
  function Overlay({ src, w, h, boxes }: { src:string; w:number; h:number; boxes:Box[] }) {
    const [nat, setNat] = useState<{w:number;h:number}>({w:0,h:0});
    const [size, setSize] = useState<{w:number;h:number}>({w:0,h:0});
    const ref = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const img = new Image();
      img.onload = () => {
        setNat({ w: img.width, h: img.height });
        const recalc = () => {
          const cw = containerRef.current?.clientWidth || img.width;
          const ratio = (h || img.height) / (w || img.width);
          setSize({ w: Math.round(cw), h: Math.round(cw * ratio) });
        };
        recalc();
        window.addEventListener("resize", recalc);
        return () => window.removeEventListener("resize", recalc);
      };
      img.src = src;
    }, [src, w, h]);

    useEffect(() => {
      const c = ref.current; if (!c) return;
      const ctx = c.getContext("2d"); if (!ctx) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
      c.style.width = `${size.w}px`;
      c.style.height = `${size.h}px`;
      ctx.setTransform(dpr,0,0,dpr,0,0);

      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0,0,size.w,size.h);
        ctx.drawImage(img, 0, 0, size.w, size.h);
        const sx = size.w / (w || nat.w || 1);
        const sy = size.h / (h || nat.h || 1);
        boxes.forEach(b => {
          ctx.save();
          ctx.strokeStyle = b.type === "ocr" ? "#eab308" : (b.type === "barcode" ? "#06b6d4" : "#ef4444");
          if (b.type === "ocr") ctx.setLineDash([6,4]);
          ctx.lineWidth = 2;
          ctx.strokeRect(Math.round(b.x*sx), Math.round(b.y*sy), Math.round(b.w*sx), Math.round(b.h*sy));
          ctx.restore();
        });
      };
      img.src = src;
    }, [src, size, boxes, w, h, nat]);

    return (
      <div ref={containerRef} className="w-full">
        <canvas ref={ref} className="rounded-xl border border-slate-200 bg-white" />
      </div>
    );
  }

  // ===== uložiť / tlačiť =====
  function saveReport() {
    if (!view) return;
    const report = {
      createdAt: (generatedAt ?? new Date()).toISOString(),
      operator: operatorName,
      orderNumber,
      productNumber,
      summary: {
        ocr: (view.ocrDiffs && view.ocrDiffs.length) ? "Chyba" : "OK",
        barcode: (view.barcodeMatch === false) || (view.barcode||[]).some(b=>b.valid===false) ? "Chyba" :
                 (view.barcode && view.barcode.length ? "OK" : "Bez kódu"),
        graphics: (view.boxes||[]).some(b=>b.type==="diff") ? "Chyba" : "OK",
      },
      ocr: { master: view.ocrMaster, scan: view.ocrScan, diffs: view.ocrDiffs || [] },
      barcode: { match: view.barcodeMatch, items: view.barcode || [] },
      graphics: { diffBoxes: view.boxes || [] },
      image: view.url
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `scancontroll-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function printPage() { window.print(); }

  // ===== summary badges =====
  const summary = useMemo(() => {
    if (!view) return { text:"–", bc:"–", gfx:"–", bcMismatch:false };
    const textErr = !!(view.ocrDiffs && view.ocrDiffs.length);
    const bcMismatch = (view.barcodeMatch === false);
    const bcHasErr = bcMismatch || (view.barcode || []).some(b => b.valid === false);
    const gfxHasErr = (view.boxes || []).some(b => b.type === "diff");
    return {
      text: textErr ? "Chyba" : "OK",
      bc: bcHasErr ? "Chyba" : (view.barcode && view.barcode.length ? "OK" : "Bez kódu"),
      gfx: gfxHasErr ? "Chyba" : "OK",
      bcMismatch
    };
  }, [view]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 print:bg-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* HEADER s poliami */}
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <h1 className="text-2xl font-bold text-center sm:text-left">
            GPCS ScanControll
          </h1>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <input
              value={operatorName}
              onChange={(e)=>setOperatorName(e.target.value)}
              placeholder="Meno operátora"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm w-full sm:w-auto"
            />
            <input
              value={orderNumber}
              onChange={(e)=>setOrderNumber(e.target.value)}
              placeholder="Číslo zákazky"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm w-full sm:w-auto"
            />
            <input
              value={productNumber}
              onChange={(e)=>setProductNumber(e.target.value)}
              placeholder="Číslo produktu"
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm w-full sm:w-auto"
            />
            <button
              onClick={() => { localStorage.removeItem("etis_auth"); location.href = "/login"; }}
              className="text-sm text-slate-300 hover:text-white sm:ml-2"
            >
              Odhlásiť
            </button>
          </div>
        </header>

        {/* Upload panel */}
        <div className="grid md:grid-cols-2 gap-6 print:hidden">
          {/* MASTER */}
          <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
            <div className="text-sm font-semibold mb-2">Master etiketa</div>

            <div className="flex flex-col sm:flex-row gap-2 mb-2">
              <button
                type="button"
                onClick={() => masterFileInputRef.current?.click()}
                className="flex-1 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
              >
                Nahrať z galérie
              </button>
              <button
                type="button"
                onClick={() => masterCameraInputRef.current?.click()}
                className="flex-1 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm"
              >
                Odfotiť etiketu
              </button>
            </div>

            <input
              ref={masterFileInputRef}
              type="file"
              accept="image/*"
              onChange={onMasterFromGallery}
              className="hidden"
            />
            <input
              ref={masterCameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onMasterFromCamera}
              className="hidden"
            />

            {masterUrl && (
              <img
                src={masterUrl}
                alt="master"
                className="mt-3 rounded-lg border border-slate-700 max-h-64 mx-auto"
              />
            )}
          </div>

          {/* SCAN */}
          <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5">
            <div className="text-sm font-semibold mb-2">Etiketa na porovnanie</div>

            <div className="flex flex-col sm:flex-row gap-2 mb-2">
              <button
                type="button"
                onClick={() => etiketaFileInputRef.current?.click()}
                className="flex-1 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
              >
                Nahrať z galérie
              </button>
              <button
                type="button"
                onClick={() => etiketaCameraInputRef.current?.click()}
                className="flex-1 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-sm"
              >
                Odfotiť etiketu
              </button>
            </div>

            <input
              ref={etiketaFileInputRef}
              type="file"
              accept="image/*"
              onChange={onEtiketaFromGallery}
              className="hidden"
            />
            <input
              ref={etiketaCameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onEtiketaFromCamera}
              className="hidden"
            />

            {etiketaUrl && (
              <img
                src={etiketaUrl}
                alt="etiketa"
                className="mt-3 rounded-lg border border-slate-700 max-h-64 mx-auto"
              />
            )}
          </div>
        </div>

        {/* Tlačidlo Porovnať */}
        <div className="mt-6 print:hidden">
          <button
            onClick={doCompare}
            disabled={isComparing || !masterFile || !etiketaFile}
            className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-xl w-full sm:w-auto"
          >
            {isComparing ? "Porovnávam…" : "Porovnať"}
          </button>
        </div>

        {/* Results */}
        {view ? (
          <div className="mt-8 grid md:grid-cols-[1.2fr_0.8fr] gap-8 items-start">
            {/* ĽAVÝ STĹPEC: náhľad + tlačidlá na SPODKU */}
            <div>
              <div className="rounded-2xl bg-white p-4 text-slate-900 border">
                <Overlay src={view.url} w={view.w} h={view.h} boxes={view.boxes || []} />
              </div>

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-slate-300">
                  {generatedAt ? `Report: ${generatedAt.toLocaleString()}` : null}
                </div>
                <div className="flex gap-3 print:hidden">
                  <button
                    onClick={saveReport}
                    className="bg-sky-600 hover:bg-sky-700 text-white font-semibold px-5 py-3 rounded-xl"
                  >
                    Uložiť
                  </button>
                  <button
                    onClick={printPage}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-3 rounded-xl"
                  >
                    Tlačiť
                  </button>
                </div>
              </div>
            </div>

            {/* PRAVÝ STĹPEC: vyhodnotenie */}
            <div className="rounded-2xl bg-slate-800/60 border border-slate-700 p-5 space-y-5">
              <h2 className="text-xl font-bold">Vyhodnotenie</h2>

              {/* Meta info pre tlač */}
              <div className="text-sm text-slate-300 hidden print:block">
                <div><b>Operátor:</b> {operatorName || "-"}</div>
                <div><b>Číslo zákazky:</b> {orderNumber || "-"}</div>
                <div><b>Číslo produktu:</b> {productNumber || "-"}</div>
                <div><b>Dátum/čas:</b> {generatedAt ? generatedAt.toLocaleString() : "-"}</div>
              </div>

              {/* TEXT (OCR) */}
              <div>
                <div className="flex items-center gap-2">
                  <b>TEXT:</b>
                  {summary.text === "OK" ? <span className="text-green-400">OK</span> :
                   summary.text === "Chyba" ? <span className="text-red-400">Chyba</span> :
                   <span className="text-slate-300">–</span>}
                </div>

                {!!(view.ocrDiffs && view.ocrDiffs.length) && (
                  <div className="text-sm mt-2 space-y-2">
                    <div className="text-slate-400 mb-1">
                      Rozdielne riadky: {view.ocrDiffs.length}
                    </div>
                    <ul className="space-y-1 max-h-48 overflow-auto pr-1">
                      {view.ocrDiffs.map((d, i) => {
                        const m = d.master.length > 60 ? d.master.slice(0, 57) + "…" : d.master;
                        const s = d.scan.length   > 60 ? d.scan.slice(0, 57)   + "…" : d.scan;
                        return (
                          <li key={i} className="bg-slate-900/50 rounded p-2 text-slate-200">
                            <div className="text-xs text-slate-400 mb-1">riadok {d.line}</div>
                            <div><span className="text-slate-400">M:</span> {m || <em className="text-slate-500">∅</em>}</div>
                            <div><span className="text-slate-400">S:</span> <span className="text-amber-300">{s || <em className="text-slate-500">∅</em>}</span></div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>

              {/* BARCODE */}
              <div>
                <div className="flex items-center gap-2">
                  <b>Čiarový kód:</b>
                  {summary.bc === "OK" ? <span className="text-green-400">OK</span> :
                   summary.bc === "Chyba" ? <span className="text-red-400">Chyba</span> :
                   <span className="text-slate-300">Bez kódu</span>}
                  {summary.bcMismatch && <span className="ml-2 text-red-300 text-sm">(nezhoda Master vs Scan)</span>}
                </div>

                {!!(view.barcode && view.barcode.length) && (
                  <ul className="text-sm text-slate-300 mt-2 space-y-1">
                    {view.barcode.map((b, i) => (
                      <li key={i}>
                        {b.side ? (
                          <span className={`px-2 py-0.5 rounded mr-2 ${b.side==='master'?'bg-slate-700':'bg-emerald-700'} text-white`}>
                            {b.side}
                          </span>
                        ) : null}
                        {b.symbology}: <span className="font-mono">{b.value}</span>{" "}
                        {b.valid ? (
                          <span className="text-green-400">(OK)</span>
                        ) : (
                          <span className="text-red-400">
                            (CHYBA{b.reason ? `: ${b.reason}` : ""})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* GRAFIKA */}
              <div>
                <div className="flex items-center gap-2">
                  <b>Grafika:</b>
                  {summary.gfx === "OK" ? <span className="text-green-400">OK</span> :
                   summary.gfx === "Chyba" ? <span className="text-red-400">Chyba</span> :
                   <span className="text-slate-300">–</span>}
                  {view.boxes?.length ? (
                    <span className="text-sm text-slate-300">Nájdené rozdiely: {view.boxes.length}</span>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-8 text-slate-300">Tu sa zobrazia výsledky.</p>
        )}

        {/* CROP MODAL */}
        {cropMode && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full mx-4 p-4 sm:p-6">
              <h2 className="text-lg font-semibold mb-3">
                {cropMode === "master" ? "Orez master etikety" : "Orez porovnávanej etikety"}
              </h2>
              <p className="text-slate-300 text-sm mb-3">
                Potiahni prstom alebo myšou oblasť etikety. Biely papier nechaj mimo výrezu.
              </p>

              <div className="relative w-full max-h-[70vh]">
                <img
                  src={cropSrc}
                  alt="crop"
                  className="block w-full h-auto rounded-lg border border-slate-700"
                  onLoad={(e) => {
                    setCropSize({
                      w: e.currentTarget.clientWidth,
                      h: e.currentTarget.clientHeight,
                    });
                  }}
                />
                <div
                  ref={cropOverlayRef}
                  className="absolute inset-0 cursor-crosshair"
                  onMouseDown={handleCropStart}
                  onMouseMove={handleCropMove}
                  onMouseUp={handleCropEnd}
                  onMouseLeave={handleCropEnd}
                  onTouchStart={handleCropStart}
                  onTouchMove={handleCropMove}
                  onTouchEnd={handleCropEnd}
                >
                  {cropRect && (
                    <div
                      className="absolute border-2 border-emerald-400 bg-emerald-400/10"
                      style={{
                        left: `${cropRect.x}px`,
                        top: `${cropRect.y}px`,
                        width: `${cropRect.w}px`,
                        height: `${cropRect.h}px`,
                      }}
                    />
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-col sm:flex-row justify-end gap-3">
                <button
                  onClick={cancelCrop}
                  className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm"
                >
                  Zrušiť
                </button>
                <button
                  onClick={applyCrop}
                  disabled={!cropRect || cropRect.w < 10 || cropRect.h < 10}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold"
                >
                  Použiť výrez
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}








